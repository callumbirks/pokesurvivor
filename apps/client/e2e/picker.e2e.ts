// The Pokémon picker: searching, filtering and choosing a Pokémon for a solo run, and changing
// it in a room, where the other member sees the change. Extra Pokémon come from quick solo runs
// reported over the API (a rescue and a caught shiny each, within the server's caps).
// E2E_SHOTS=<dir> saves screenshots on desktop and on a phone in landscape.
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

const shots = process.env.E2E_SHOTS;
const suffix = randomUUID().slice(0, 8);
const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 844, height: 390 };

const shot = async (page: Page, name: string) => {
  if (!shots) return;
  // Without the toasts of the setup (friend requests, achievements).
  await page.evaluate(() => document.querySelector('.toasts')?.replaceChildren());
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/${name}.png` });
};

async function newPlayer(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(name);
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('skip-test').click();
  await page.getByTestId('starter-4').click(); // Charmander
  await page.getByTestId('starter-ok').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  return page;
}

/** Owns more Pokémon: per pair, a run that rescues the first and catches the second's shiny. */
async function collect(page: Page, pairs: [rescued: number, shiny: number][]): Promise<void> {
  await page.evaluate(async (list) => {
    const post = async (url: string, body: unknown) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
      return (await res.json()) as { runId: string };
    };
    for (const [rescued, shiny] of list) {
      const { runId } = await post('/api/runs/start', { pokemon: { dex: 4, shiny: false } });
      await post('/api/runs', {
        runId,
        durationS: 0,
        level: 1,
        kills: 0,
        bosses: 0,
        coins: 0,
        ticketsX1: 0,
        ticketsX10: 0,
        shiniesCaught: [shiny],
        progress: {
          defeatsByType: {},
          chestsOpened: 0,
          itemsEquipped: [],
          movesEvolved: [],
          riftWins: [],
          legendariesDefeated: [],
          rescued: [rescued],
        },
      });
    }
  }, pairs);
  // The app reads the save again.
  await page.reload();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
}

const partnerDex = (page: Page) =>
  page.evaluate(() =>
    fetch('/api/save')
      .then((r) => r.json())
      .then((s: { partner: { dex: number } }) => s.partner.dex),
  );

test('solo: search, filter, sort and play with the picked Pokémon', async ({ browser }) => {
  const page = await newPlayer(browser, `pick_${suffix}`);
  // Bulbasaur, Squirtle and Chikorita rescued; Pikachu and Eevee caught shiny.
  await collect(page, [
    [1, 25],
    [7, 133],
    [152, 25],
  ]);
  await page.goto('/#solo');
  const picker = page.getByTestId('solo-picker');
  const cells = picker.locator('[data-testid^="solo-pick-"]');
  // The partner is pre-selected, with its details.
  await expect(cells).toHaveCount(6);
  await expect(page.getByTestId('solo-pick-4')).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('solo-detail').getByTestId('detail-name')).toHaveText('Charmander');
  await expect(page.getByTestId('solo-count')).toHaveText('6 of 6');
  await shot(page, 'solo-desktop');
  if (shots) {
    // A big screen (the menus scale up), and the collection that shares the cells and details.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await shot(page, 'solo-1080p');
    await page.setViewportSize(DESKTOP);
    await page.goto('/#collection');
    await shot(page, 'collection');
    await page.goto('/#solo');
  }

  // Search as you type, by part of the name.
  await page.getByTestId('solo-search').fill('squ');
  await expect(cells).toHaveCount(1);
  await expect(page.getByTestId('solo-pick-7')).toBeVisible();
  // The partner's details stay while it's filtered out.
  await expect(page.getByTestId('solo-detail').getByTestId('detail-name')).toHaveText('Charmander');
  await shot(page, 'solo-search');
  await page.getByTestId('solo-search').fill('zzz');
  await expect(page.getByTestId('solo-none')).toBeVisible();
  await page.getByTestId('solo-search').fill('');

  // Filters: a type, the shiny chip, a region; Clear resets them (not the search).
  await page.getByTestId('solo-type-grass').click();
  await expect(cells).toHaveCount(2);
  await page.getByTestId('region-2').click();
  await expect(cells).toHaveCount(1);
  await expect(page.getByTestId('solo-pick-152')).toBeVisible();
  await expect(page.getByTestId('solo-filters')).toHaveText('Filters (2)');
  await shot(page, 'solo-filters');
  await page.getByTestId('solo-clear').click();
  await page.getByTestId('solo-shiny').click();
  await expect(cells).toHaveCount(2);
  await page.getByTestId('solo-shiny').click();
  await expect(cells).toHaveCount(6);

  // Sort by name: Bulbasaur first.
  while (!(await page.getByTestId('solo-sort').textContent())?.includes('Name'))
    await page.getByTestId('solo-sort').click();
  await expect(cells.first()).toHaveAttribute('data-testid', 'solo-pick-1');

  // On a phone in landscape the filters fold away and Play stays in view.
  await page.setViewportSize(PHONE);
  await expect(page.getByTestId('region-1')).toBeHidden();
  await expect(page.getByTestId('solo-start')).toBeInViewport();
  await shot(page, 'solo-phone');
  await page.getByTestId('solo-filters').click();
  await expect(page.getByTestId('region-1')).toBeVisible();
  await expect(page.getByTestId('solo-start')).toBeInViewport();
  await shot(page, 'solo-phone-filters');
  await page.getByTestId('solo-filters').click();

  // The keyboard: Enter in the search picks the first result and goes to it, Enter there goes
  // on to Play, and Esc leaves the field rather than the screen.
  await page.getByTestId('solo-search').fill('pika');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-solo')).toBeVisible();
  await page.getByTestId('solo-search').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('solo-pick-25')).toBeFocused();
  await expect(page.getByTestId('solo-detail').getByTestId('detail-name')).toHaveText('Pikachu');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('solo-start')).toBeFocused();
  await page.setViewportSize(DESKTOP);
  await page.keyboard.press('Enter');
  // Play makes it the partner and starts the run with it.
  await expect(page.getByTestId('screen-play')).toBeVisible();
  expect(await partnerDex(page)).toBe(25);
  await expect(page.getByTestId('game-phase')).toHaveText('running', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await page.getByTestId('game-exit').click();
  await expect(page.getByTestId('results')).toBeVisible();
});

test('the keys: from the grid to Play and back, and Play uses the selected Pokémon, not the focused one', async ({
  browser,
}) => {
  const page = await newPlayer(browser, `pkey_${suffix}`);
  // Bulbasaur, Squirtle, Pikachu, Eevee and Chikorita: one row of six with Charmander.
  await collect(page, [
    [1, 25],
    [7, 133],
    [152, 25],
  ]);
  await page.goto('/#solo');
  const selected = page.getByTestId('solo-picker').locator('.cell.on');
  const name = page.getByTestId('solo-detail').getByTestId('detail-name');
  await expect(selected).toHaveAttribute('data-testid', 'solo-pick-4');

  // The focus starts on the selection and moves along the row without changing it; → from the
  // grid's right edge goes to Play, ← back to the selection.
  for (const dex of [7, 25, 133, 152]) {
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId(`solo-pick-${dex}`)).toBeFocused();
  }
  await expect(selected).toHaveAttribute('data-testid', 'solo-pick-4');
  await expect(name).toHaveText('Charmander');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('solo-start')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('solo-pick-4')).toBeFocused();
  // The mouse over a cell doesn't select it either.
  await page.getByTestId('solo-pick-133').hover();
  await expect(name).toHaveText('Charmander');

  // Enter selects (and goes on to Play); the focus passing over another one afterwards doesn't.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('solo-start')).toBeFocused();
  await expect(selected).toHaveAttribute('data-testid', 'solo-pick-7');
  await expect(name).toHaveText('Squirtle');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('solo-pick-7')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('solo-pick-25')).toBeFocused();
  await shot(page, 'solo-keys-focus');

  // On a phone in landscape and in portrait too: → from the grid's edge reaches Play (after the
  // rest of the row, however many cells the screen fits in it).
  const start = page.getByTestId('solo-start');
  const onStart = () => start.evaluate((e) => e === document.activeElement);
  for (const size of [PHONE, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.getByTestId('solo-pick-25').focus();
    for (let i = 0; i < 6 && !(await onStart()); i++) await page.keyboard.press('ArrowRight');
    await expect(start).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('solo-pick-7')).toBeFocused();
  }
  await page.setViewportSize(DESKTOP);

  // Play from the last focused cell (Pikachu) starts with the selected one (Squirtle).
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('solo-pick-25')).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(start).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('screen-play')).toBeVisible();
  expect(await partnerDex(page)).toBe(7);
  await expect(page.getByTestId('game-phase')).toHaveText('running', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await page.getByTestId('game-exit').click();
  await expect(page.getByTestId('results')).toBeVisible();
});

test('room: change the Pokémon by search, and the other member sees it', async ({ browser }) => {
  const a = `pra_${suffix}`;
  const b = `prb_${suffix}`;
  const [pa, pb] = await Promise.all([newPlayer(browser, a), newPlayer(browser, b)]);
  await collect(pb, [[7, 25]]);
  // Friends over the API, then a room from the UI.
  await pa.evaluate(
    (name) =>
      fetch('/api/friends/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name }),
      }),
    b,
  );
  await pb.evaluate((name) => fetch(`/api/friends/requests/${name}/accept`, { method: 'POST' }), a);
  await pa.goto('/#lobby');
  await pa.getByTestId('room-create').click();
  await pa.getByTestId(`invite-${b}`).click();
  await pb.getByTestId('invite-accept').click();
  const card = pa.getByTestId(`member-${b}`);
  await expect(card).toContainText('Charmander');
  // Ready doesn't stop a change: the room shows the new one either way.
  await pb.getByTestId('room-ready').click();

  // B opens the picker: the partner is selected; Back returns to the room.
  await pb.getByTestId('room-change-partner').click();
  await expect(pb.getByTestId('room-pick-4')).toHaveClass(/\bon\b/);
  await expect(pb.getByTestId('room-confirm')).toBeDisabled();
  await pb.getByTestId('back').click();
  await expect(pb.getByTestId('room-ready')).toBeVisible();
  await pb.getByTestId('room-change-partner').click();
  await pb.getByTestId('room-search').fill('squir');
  await expect(pb.locator('[data-testid^="room-pick-"]')).toHaveCount(1);
  await shot(pb, 'room-search');
  await pb.getByTestId('room-pick-7').click();
  await expect(pb.getByTestId('room-detail').getByTestId('detail-name')).toHaveText('Squirtle');
  await pb.setViewportSize(PHONE);
  await expect(pb.getByTestId('room-confirm')).toBeInViewport();
  await shot(pb, 'room-phone');
  await pb.setViewportSize(DESKTOP);
  // With the keys: the focus passes over Pikachu on the way to the confirm button, which still
  // chooses Squirtle.
  await pb.getByTestId('room-search').fill('');
  await pb.keyboard.press('Escape');
  await expect(pb.locator('[data-testid^="room-pick-"]')).toHaveCount(3);
  await pb.keyboard.press('ArrowRight');
  await expect(pb.getByTestId('room-pick-25')).toBeFocused();
  await pb.keyboard.press('ArrowRight');
  await expect(pb.getByTestId('room-confirm')).toBeFocused();
  await expect(pb.getByTestId('room-detail').getByTestId('detail-name')).toHaveText('Squirtle');
  await pb.keyboard.press('Enter');

  // Back in the room, and A sees Squirtle on B's card.
  await expect(pb.getByTestId('room-ready')).toBeVisible();
  await expect(card).toContainText('Squirtle');
  await expect(pb.getByTestId(`member-${b}`)).toContainText('Squirtle');
  await shot(pa, 'room-desktop');
});
