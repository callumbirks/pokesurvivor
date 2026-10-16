// Prestige against the real server: a fully upgraded partner gets the Prestige button, the dialog
// says what resets and the gems it costs, confirming resets the upgrades for a star, and the stars
// show in the menu, the collection, the solo picker and the run's HUD. Then an upgrade reset: buy
// upgrades, reset them for gems and get the coins back. E2E_SHOTS=<dir> saves screenshots.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { loadGameData } from '@pokesurvivor/data';
import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db/index.js';
import { withLockedSave } from '../../server/src/saves/service.js';
import type { TestApp } from '../../server/src/test/harness.js';

const shots = process.env.E2E_SHOTS;
const data = loadGameData();
const { prestigeCost, resetCost } = data.tuning.gems;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/prestige-${name}.png` });
};

test('prestige a fully upgraded partner and see its stars', async ({ page }) => {
  const name = `elm_${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(name);
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  for (let i = 0; i < 8; i++) await page.getByTestId('answer-1').click();
  await page.getByTestId('starter-accept').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();

  // Fixture: the partner has one star and every upgrade maxed; a second Pokémon has three.
  const save = (await (await page.request.get('/api/save')).json()) as {
    partner: { dex: number };
  };
  const dex = save.partner.dex;
  const { user } = (await (await page.request.get('/api/auth/me')).json()) as {
    user: { id: string };
  };
  const db: TestApp['db'] = createDb(loadConfig().databaseUrl);
  try {
    await withLockedSave(db.db, user.id, (s) => {
      s.data.upgrades[String(dex)] = Object.fromEntries(
        data.upgrades.map((u) => [u.id, u.maxLevel]),
      );
      s.data.prestige[String(dex)] = 1;
      s.data.owned['25'] ??= { at: Date.now(), from: 'gacha' };
      s.data.prestige['25'] = data.tuning.prestige.maxStars;
      s.wallet.credit('gems', prestigeCost + 23, 'admin_adjustment');
    });
  } finally {
    await db.close();
  }
  await page.reload();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  await expect(page.locator('[data-testid="partner-name"] [data-testid="stars"]')).toHaveText('★');
  await expect(page.getByTestId('topbar-gems')).toHaveText(String(prestigeCost + 23));
  await shot(page, 'menu-partner');
  if (shots) await page.locator('.topbar').screenshot({ path: `${shots}/prestige-topbar.png` });

  // The upgrades screen: stats with the prestige share, and the button.
  await page.getByTestId('menu-shop').click();
  const button = page.getByTestId('prestige-button');
  await expect(button).toBeEnabled();
  await expect(page.locator('.prestige-stats .bar b')).toHaveCount(3);
  await shot(page, 'upgrades-ready');

  // The dialog says what resets and what it gains; cancel changes nothing.
  await button.click();
  const dialog = page.getByTestId('prestige-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`All ${data.upgrades.length} upgrades`);
  await expect(dialog.locator('[data-testid="prestige-gains"] .chip')).toHaveCount(6);
  await expect(dialog.getByTestId('prestige-cost')).toContainText(`Costs ${prestigeCost} gems`);
  await shot(page, 'prestige-dialog');
  await page.getByTestId('dialog-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeEnabled();

  await button.click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.locator('.prestige-head [data-testid="stars"]')).toHaveText('★★');
  await expect(button).toBeDisabled();
  await expect(page.locator('.pips i.on')).toHaveCount(0);
  const after = (await (await page.request.get('/api/save')).json()) as {
    prestige: Record<string, number>;
    upgrades: Record<string, unknown>;
  };
  expect(after.prestige[String(dex)]).toBe(2);
  expect(after.upgrades[String(dex)]).toBeUndefined();
  await expect(page.getByTestId('topbar-gems')).toHaveText('23');
  await shot(page, 'upgrades-after');

  // At the most stars there is no button.
  await page.getByTestId('shop-pokemon').selectOption('25');
  await expect(page.getByTestId('prestige-status')).toContainText('the highest');
  await expect(button).toHaveCount(0);
  await shot(page, 'upgrades-max');

  // The collection and the solo picker show the stars on the cells and the details.
  await page.goto('/#collection');
  await expect(page.locator(`[data-testid="dex-${dex}"] [data-testid="stars"]`)).toHaveText('★★');
  await page.getByTestId('region-1').click();
  await expect(page.locator(`[data-testid="dex-25"] [data-testid="stars"]`)).toHaveText('★★★');
  await page.getByTestId('dex-25').click();
  await expect(page.locator('[data-testid="prestige-box"]')).toBeVisible();
  await shot(page, 'collection');
  await page.goto('/#solo');
  await expect(page.locator(`[data-testid="solo-pick-${dex}"] [data-testid="stars"]`)).toHaveText(
    '★★',
  );
  await shot(page, 'solo-picker');

  // In the run: the HUD shows the stars by the name (and the stats panel includes the bonus).
  await page.getByTestId('solo-start').click();
  await expect(page.getByTestId('game-phase')).toHaveText('running');
  await page.waitForTimeout(1500);
  await shot(page, 'hud');
});

test('reset an upgraded Pokémon for gems and get its coins back', async ({ page }) => {
  const name = `oak_${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(name);
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  for (let i = 0; i < 8; i++) await page.getByTestId('answer-1').click();
  await page.getByTestId('starter-accept').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  const { user } = (await (await page.request.get('/api/auth/me')).json()) as {
    user: { id: string };
  };
  const db: TestApp['db'] = createDb(loadConfig().databaseUrl);
  try {
    await withLockedSave(db.db, user.id, (s) => {
      s.data.prestige[String(s.partner.dex)] = 1;
      s.wallet.credit('gems', resetCost - 1, 'admin_adjustment');
    });
  } finally {
    await db.close();
  }
  type Balance = { coins: number; gems: number; upgrades: Record<string, unknown> };
  const balance = async () => (await (await page.request.get('/api/save')).json()) as Balance;
  const start = await balance();

  // Nothing bought yet: nothing to reset.
  await page.goto('/#shop');
  const reset = page.getByTestId('reset-button');
  await expect(reset).toHaveAttribute('data-refund', '0');
  await expect(reset).toBeDisabled();
  const buys = ['max-hp', 'max-hp', 'attack'];
  for (const [i, id] of buys.entries()) {
    await page.getByTestId(`buy-${id}`).click();
    await expect(page.locator('.pips i.on')).toHaveCount(i + 1);
  }
  const bought = await balance();
  const spent = start.coins - bought.coins;
  expect(spent).toBeGreaterThan(0);
  // One gem short.
  await expect(reset).toHaveAttribute('data-refund', String(spent));
  await expect(reset).toBeDisabled();

  const db2: TestApp['db'] = createDb(loadConfig().databaseUrl);
  try {
    await withLockedSave(db2.db, user.id, (s) => s.wallet.credit('gems', 1, 'admin_adjustment'));
  } finally {
    await db2.close();
  }
  await page.reload();
  await expect(reset).toBeEnabled();
  await reset.click();
  const dialog = page.getByTestId('reset-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('reset-refund')).toContainText(
    `+${spent.toLocaleString('en')} PokéCoins`,
  );
  await expect(dialog.getByTestId('reset-cost')).toContainText(`Costs ${resetCost} gems`);
  await expect(dialog.getByTestId('reset-keeps')).toContainText('prestige stars stay (1)');
  await shot(page, 'reset-dialog');
  await page.getByTestId('dialog-confirm').click();
  await expect(page.locator('.pips i.on')).toHaveCount(0);
  await expect(page.getByTestId('topbar-gems')).toHaveText('0');
  const after = await balance();
  expect(after.coins).toBe(start.coins);
  expect(after.gems).toBe(0);
  expect(after.upgrades).toEqual({});
  await expect(reset).toBeDisabled();
  await shot(page, 'reset-after');
});
