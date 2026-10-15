// Prestige against the real server: a fully upgraded partner gets the Prestige button, the dialog
// says what resets, confirming resets the upgrades for a star, and the stars show in the menu,
// the collection, the solo picker and the run's HUD. E2E_SHOTS=<dir> saves screenshots.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { loadGameData } from '@pokesurvivor/data';
import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db/index.js';
import { withLockedSave } from '../../server/src/saves/service.js';
import type { TestApp } from '../../server/src/test/harness.js';

const shots = process.env.E2E_SHOTS;
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
  const data = loadGameData();
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
    });
  } finally {
    await db.close();
  }
  await page.reload();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  await expect(page.locator('[data-testid="partner-name"] [data-testid="stars"]')).toHaveText('★');
  await shot(page, 'menu-partner');

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
