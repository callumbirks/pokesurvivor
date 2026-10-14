// Single-player screens against the real server: the shop with its move bans and slots, settings sync,
// the solo flow up to the game, What's new, and logging out and back in. E2E_SHOTS=<dir> saves
// screenshots of the menu and What's new.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.E2E_SHOTS;
const changelog = JSON.parse(
  readFileSync(new URL('../../../packages/data/changelog.json', import.meta.url), 'utf8'),
) as { versions: { version: number }[] };
const latest = changelog.versions[0]?.version;
/** A screenshot once the screen's pop-in animation is over. */
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/${name}.png` });
};

test('shop, moves, settings, solo and login again', async ({ page }) => {
  const name = `oak_${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(name);
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();

  // The personality test suggests a starter.
  for (let i = 0; i < 8; i++) await page.getByTestId('answer-1').click();
  await page.getByTestId('starter-accept').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  const partner = (await page.getByTestId('partner-name').textContent())?.trim() ?? '';
  expect(partner.length).toBeGreaterThan(0);
  // The menu: a pixel-art icon per entry, the coins/tickets counters, the living world behind.
  await expect(page.locator('.menu-item .mi-ico img.pix')).toHaveCount(9);
  await expect(page.locator('.topbar img.pix')).toHaveCount(4);
  await expect(page.locator('canvas.backdrop')).toBeVisible();

  // What's new: a new device sees a dot while there's a release (it never opens by itself);
  // opening the screen marks it seen. Before the first release: no dot, an empty state.
  await expect(page.getByTestId('menu-changelog-dot')).toHaveCount(latest ? 1 : 0);
  await expect(page.getByTestId('screen-changelog')).toHaveCount(0);
  await shot(page, 'menu-dot');
  await page.getByTestId('menu-changelog').click();
  await expect(page.getByTestId('screen-changelog')).toBeVisible();
  await expect(page.getByTestId(latest ? `cl-v${latest}` : 'cl-empty')).toBeVisible();
  await shot(page, 'whats-new');
  if (shots && latest) {
    // The releases below the dev build's unreleased lines, opened up, and on a phone in landscape.
    await page.getByTestId(`cl-v${latest}`).scrollIntoViewIfNeeded();
    await page.locator('[data-testid="cl-bts"] summary').first().click();
    await shot(page, 'whats-new-releases');
    await page.setViewportSize({ width: 844, height: 390 });
    await shot(page, 'whats-new-phone');
    await page.getByTestId('back').click();
    await shot(page, 'menu-phone-seen');
    await page.getByTestId('menu-changelog').click();
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await page.getByTestId('back').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  await expect(page.getByTestId('menu-changelog-dot')).toHaveCount(0);

  // Shop: 500 coins + 100 from the first-partner achievement buys a level of "ban" (300).
  await page.getByTestId('menu-shop').click();
  const price = (await page.getByTestId('buy-ban').textContent())?.trim();
  await page.getByTestId('buy-ban').click();
  // The next level costs more (the price comes from the server's rules).
  await expect(page.getByTestId('buy-ban')).not.toHaveText(price ?? '');

  // Still in the shop, as in legacy: open the ban picker from the upgrade (1/1 allowed now), ban
  // a move, and bind a move to slot 2 below.
  await expect(page.getByTestId('choose-bans')).toHaveText('Choose (0/1)');
  await page.getByTestId('choose-bans').click();
  const ban = page.locator('[data-testid="ban-picker"] [data-testid^="ban-"]').first();
  await ban.click();
  await expect(page.locator('[data-testid^="ban-"].ban')).toHaveCount(1);
  await expect(page.getByTestId('choose-bans')).toHaveText('Choose (1/1)');
  const slot = page.getByTestId('bind-1');
  const option = await slot.locator('option').nth(2).getAttribute('value');
  await slot.selectOption(option ?? '');
  await expect(page.getByTestId('bind-1')).toHaveValue(option ?? '');
  // The collection no longer has an editor.
  await page.getByTestId('back').click();
  await page.getByTestId('menu-collection').click();
  await expect(page.getByTestId('collection-detail')).toBeVisible();
  await expect(page.locator('[data-testid^="ban-"], [data-testid^="bind-"]')).toHaveCount(0);

  // Settings sync to the account: change one, reload, it's still set.
  await page.goto('/#settings');
  // The build's version in a corner: `vN`, `vN+dev` with unreleased changes, `dev` before v1.
  await expect(page.getByTestId('version')).toHaveText(
    latest ? new RegExp(`^v${latest}(\\+dev)?$`) : 'dev',
  );
  await shot(page, 'settings-version');
  await page.getByTestId('set-tab-graphics').click();
  await page.getByTestId('set-showFps').click();
  await expect(page.getByTestId('set-showFps')).toHaveText('Yes');
  await page.waitForTimeout(1000); // debounced save
  const saved = await page.evaluate(() =>
    fetch('/api/save')
      .then((r) => r.json())
      .then((s: { settings: { showFps: boolean } }) => s.settings.showFps),
  );
  expect(saved).toBe(true);

  // Solo: start a run (the game client takes over), quit it from the pause menu: the run ends
  // and is reported (POST /api/runs), the results show what was credited, back to the menu.
  await page.goto('/#solo');
  await page.getByTestId('solo-start').click();
  await expect(page.getByTestId('screen-play')).toBeVisible();
  // The run has its own canvas: the menu's world stops.
  await expect(page.locator('canvas.backdrop')).toBeHidden();
  // The connection starts the run on the server (POST /api/runs/start) before it runs.
  await expect(page.getByTestId('game-phase')).toHaveText('running');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause')).toBeVisible();
  // The pause menu opens the full settings over the game (the route stays: leaving it would end
  // the run). The run stays paused in them, and their back button returns to the pause menu.
  const simTime = () =>
    page.evaluate(
      () => (window as unknown as { __psCounts?: { time: number } }).__psCounts?.time ?? -1,
    );
  await page.getByTestId('pause-settings').click();
  await expect(page.getByTestId('screen-settings')).toBeVisible();
  expect(page.url()).toMatch(/#play$/);
  const pausedAt = await simTime();
  await page.waitForTimeout(800);
  expect(await simTime()).toBe(pausedAt);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('screen-settings')).toHaveCount(0);
  await expect(page.getByTestId('pause')).toBeVisible();
  expect(await simTime()).toBe(pausedAt);
  // Esc closes them too.
  await page.getByTestId('pause-settings').click();
  await expect(page.getByTestId('screen-settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-settings')).toHaveCount(0);
  await expect(page.getByTestId('pause')).toBeVisible();
  await page.getByTestId('game-exit').click();
  await expect(page.getByTestId('results')).toBeVisible();
  await expect(page.getByTestId('game-phase')).toHaveText('ended');
  await expect(page.getByTestId('not-credited')).toHaveCount(0);
  await page.getByTestId('game-exit').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();

  // Log out, then log in again: straight to the menu with the same partner.
  await page.goto('/#settings');
  await page.getByTestId('set-tab-account').click();
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('screen-login')).toBeVisible();
  await page.getByTestId('login-username').fill(name);
  await page.getByTestId('login-password').fill('wrong-password');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toHaveText('Wrong username or password.');
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('partner-name')).toHaveText(partner);
});
