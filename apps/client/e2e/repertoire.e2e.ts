// Repertoire's second starting move against the real server: once bought, its upgrade card has a
// drop-down (Random, then the moves the Pokémon could roll, minus bans) that saves with the mouse,
// the keys and a gamepad (left / right step through it). E2E_SHOTS=<dir> saves screenshots.
import { expect, test, type Page } from '@playwright/test';
import { loadGameData } from '@pokesurvivor/data';
import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db/index.js';
import { withLockedSave } from '../../server/src/saves/service.js';
import type { TestApp } from '../../server/src/test/harness.js';
import { nameSuffix } from './names.js';

const shots = process.env.E2E_SHOTS;
const RIGHT = 15;
const LEFT = 14;

declare global {
  interface Window {
    __pad: { id: string; buttons: boolean[]; axes: number[] };
  }
}

/** A connected standard pad whose buttons the test sets (`window.__pad`). */
function fakePad() {
  window.__pad = {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD)',
    buttons: Array<boolean>(17).fill(false),
    axes: [0, 0, 0, 0],
  };
  navigator.getGamepads = () => [
    {
      id: window.__pad.id,
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: performance.now(),
      axes: [...window.__pad.axes],
      buttons: window.__pad.buttons.map((pressed) => ({
        pressed,
        touched: pressed,
        value: +pressed,
      })),
    } as unknown as Gamepad,
  ];
}

async function press(page: Page, button: number): Promise<void> {
  await page.evaluate((b) => (window.__pad.buttons[b] = true), button);
  await page.waitForTimeout(80);
  await page.evaluate((b) => (window.__pad.buttons[b] = false), button);
  await page.waitForTimeout(80);
}

const chosen = async (page: Page) =>
  (
    (await (await page.request.get('/api/save')).json()) as {
      repertoireMoves: Record<string, string>;
    }
  ).repertoireMoves['4'] ?? null;

test('choose the Repertoire move with the mouse, the keys and a gamepad', async ({ page }) => {
  await page.addInitScript(fakePad);
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(`rep_${nameSuffix()}`);
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('skip-test').click();
  await page.getByTestId('starter-4').click();
  await page.getByTestId('starter-ok').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();

  // Without Repertoire there is no drop-down.
  await page.getByTestId('menu-shop').click();
  await expect(page.getByTestId('buy-extra-move')).toBeVisible();
  await expect(page.getByTestId('repertoire-move')).toHaveCount(0);

  // Fixture: Charmander has Repertoire and Ban, with one move banned.
  const data = loadGameData();
  const pool = [
    ...new Set([
      ...(data.movesByType.get('normal') ?? []),
      ...(data.movesByType.get('fire') ?? []),
    ]),
  ].filter((m) => m.id !== 'ember' && m.kind !== 'buff');
  const banned = pool.find((m) => m.id === 'heat-wave') ?? pool[0]!;
  const { user } = (await (await page.request.get('/api/auth/me')).json()) as {
    user: { id: string };
  };
  const db: TestApp['db'] = createDb(loadConfig().databaseUrl);
  try {
    await withLockedSave(db.db, user.id, (s) => {
      s.data.upgrades['4'] = { 'extra-move': 1, ban: 1 };
      s.data.moveBans['4'] = [banned.id];
    });
  } finally {
    await db.close();
  }
  await page.reload();
  const select = page.getByTestId('repertoire-move');
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('');
  const values = await select
    .locator('option')
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(values[0]).toBe('');
  expect(values.slice(1).sort()).toEqual(
    pool
      .filter((m) => m !== banned)
      .map((m) => m.id)
      .sort(),
  );

  // The mouse.
  await select.selectOption('flamethrower');
  await expect.poll(() => chosen(page)).toBe('flamethrower');
  await expect(select).toHaveValue('flamethrower');
  if (shots) {
    await page.waitForTimeout(400);
    await select
      .locator('xpath=ancestor::div[contains(@class,"upg-item")]')
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/repertoire-dropdown.png` });
  }

  // The keys: the arrows change it (the browser's), and the focus stays on it.
  const i = values.indexOf('flamethrower');
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => chosen(page)).toBe(values[i + 1]);
  await expect(select).toBeFocused();

  // The pad: right steps on, left steps back; back to Random clears it.
  await press(page, RIGHT);
  await expect.poll(() => chosen(page)).toBe(values[i + 2]);
  await expect(select).toBeFocused();
  for (let k = 0; k < i + 2; k++) await press(page, LEFT);
  await expect.poll(() => chosen(page)).toBe(null);
  await expect(select).toHaveValue('');
});
