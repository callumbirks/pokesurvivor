// The phase 4 exit test: two browsers, two accounts. They become friends, one invites the other,
// both get ready, one opens the gacha (busy) and the owner's start is blocked, they come back
// and the game starts for both.
import { expect, test, type Browser, type Page } from '@playwright/test';

const suffix = Date.now().toString(36).slice(-6);

async function newPlayer(browser: Browser, name: string): Promise<Page> {
  // Separate contexts: separate cookies, like two browsers.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(name);
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  // A new account picks its starter first.
  await expect(page.getByTestId('screen-starter')).toBeVisible();
  await page.getByTestId('skip-test').click();
  await page.getByTestId('starter-4').click();
  await page.getByTestId('starter-ok').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  return page;
}

const member = (page: Page, name: string) => page.getByTestId(`member-${name}`);

test('two players: invite, ready, busy blocks the start, then both play', async ({ browser }) => {
  const a = `ash_${suffix}`;
  const b = `misty_${suffix}`;
  const pa = await newPlayer(browser, a);
  const pb = await newPlayer(browser, b);

  // Friends: A sends a request, B accepts it.
  await pa.getByTestId('menu-friends').click();
  await pa.getByTestId('friend-name').fill(b);
  await pa.getByTestId('friend-add').click();
  await pb.getByTestId('menu-friends').click();
  await pb.getByTestId(`accept-${a}`).click();
  await expect(pb.getByTestId(`friend-${a}`)).toBeVisible();

  // A creates a room and invites B; B accepts from the invite popup.
  await pa.getByTestId('back').click();
  await pa.getByTestId('menu-lobby').click();
  await pa.getByTestId('room-create').click();
  await expect(member(pa, a)).toBeVisible();
  await pa.getByTestId(`invite-${b}`).click();
  await pb.getByTestId('invite-accept').click();
  await expect(pb.getByTestId('screen-lobby')).toBeVisible();
  await expect(member(pa, b)).toBeVisible();

  // Both ready: the owner can start.
  await pa.getByTestId('room-ready').click();
  await pb.getByTestId('room-ready').click();
  await expect(member(pa, b).getByTestId('member-status')).toHaveText('Ready');
  await expect(pa.getByTestId('room-start')).toBeEnabled();

  // B opens the gacha: busy, and the start is blocked with B named as the blocker.
  await pb.getByTestId('back').click();
  await pb.getByTestId('menu-gacha').click();
  await expect(pb.getByTestId('screen-gacha')).toBeVisible();
  await expect(member(pa, b).getByTestId('member-status')).toHaveText('Busy');
  await expect(pa.getByTestId('room-start')).toBeDisabled();
  await expect(pa.getByTestId('blockers')).toContainText(b);
  if (process.env.E2E_SHOTS)
    await pa.screenshot({ path: `${process.env.E2E_SHOTS}/lobby-busy.png` });

  // B comes back: ready again (restored), so the owner can start.
  await pb.getByTestId('back').click();
  await expect(member(pa, b).getByTestId('member-status')).toHaveText('Ready');
  await pb.getByTestId('menu-lobby').click();
  await expect(pa.getByTestId('room-start')).toBeEnabled();
  await pa.getByTestId('room-start').click();

  // Both are in the game.
  for (const page of [pa, pb]) {
    await expect(page.getByTestId('screen-play')).toBeVisible();
    await expect(page.getByTestId('game-phase')).toHaveText('running', { timeout: 20_000 });
  }
});
