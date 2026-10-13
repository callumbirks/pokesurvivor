// Single-player screens against the real server: shop, move slots and bans, settings sync,
// the solo flow up to the game, and logging out and back in.
import { expect, test } from '@playwright/test';

test('shop, moves, settings, solo and login again', async ({ page }) => {
  const name = `oak_${Date.now().toString(36).slice(-6)}`;
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

  // Shop: 500 coins + 100 from the first-partner achievement buys a level of "ban" (300).
  await page.getByTestId('menu-shop').click();
  const price = (await page.getByTestId('buy-ban').textContent())?.trim();
  await page.getByTestId('buy-ban').click();
  // The next level costs more (the price comes from the server's rules).
  await expect(page.getByTestId('buy-ban')).not.toHaveText(price ?? '');

  // Collection: bind a move to slot 2 and ban a move (allowed now: one ban).
  await page.getByTestId('back').click();
  await page.getByTestId('menu-collection').click();
  await page.locator('.move-settings summary').click();
  const slot = page.getByTestId('bind-1');
  const option = await slot.locator('option').nth(2).getAttribute('value');
  await slot.selectOption(option ?? '');
  await expect(page.getByTestId('bind-1')).toHaveValue(option ?? '');
  const ban = page.locator('[data-testid^="ban-"]').first();
  await ban.click();
  await expect(page.locator('[data-testid^="ban-"].ban')).toHaveCount(1);

  // Settings sync to the account: change one, reload, it's still set.
  await page.goto('/#settings');
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

  // Solo: start a run (the game client takes over), leave, back to the menu.
  await page.goto('/#solo');
  await page.getByTestId('solo-start').click();
  await expect(page.getByTestId('screen-play')).toBeVisible();
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
