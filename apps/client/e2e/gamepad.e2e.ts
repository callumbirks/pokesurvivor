// A gamepad in the real client, faked through `navigator.getGamepads`: the d-pad moves a focus
// through the menus (A presses, B goes back), prompts switch to controller glyphs while the pad is
// in use and back to keys on a key press, and in a run the pad plays until Start opens the pause
// menu (choices with the pad are unit-tested in `choice-ui.test.ts`: a level-up takes too long
// to reach here). E2E_SHOTS=<dir> saves screenshots.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.E2E_SHOTS;

/** Standard-mapping buttons. */
const A = 0;
const B = 1;
const START = 9;
const UP = 12;
const DOWN = 13;
const RIGHT = 15;

declare global {
  interface Window {
    __pad: { id: string; buttons: boolean[]; axes: number[] };
  }
}

/** A connected pad whose buttons the test sets (`window.__pad`). */
function fakePad(id: string) {
  window.__pad = { id, buttons: Array<boolean>(17).fill(false), axes: [0, 0, 0, 0] };
  navigator.getGamepads = () => {
    const p = window.__pad;
    return [
      {
        id: p.id,
        index: 0,
        connected: true,
        mapping: 'standard',
        timestamp: performance.now(),
        axes: [...p.axes],
        buttons: p.buttons.map((pressed) => ({
          pressed,
          touched: pressed,
          value: pressed ? 1 : 0,
        })),
        hapticActuator: null,
        vibrationActuator: null,
      } as unknown as Gamepad,
    ];
  };
}

/** Presses and releases a button (held for a few frames, as a thumb does). */
async function press(page: Page, button: number): Promise<void> {
  await page.evaluate((b) => (window.__pad.buttons[b] = true), button);
  await page.waitForTimeout(80);
  await page.evaluate((b) => (window.__pad.buttons[b] = false), button);
  await page.waitForTimeout(80);
}

const focusedId = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null);

test('a gamepad: glyphs, menu focus, and the pause menu', async ({ page }) => {
  await page.addInitScript(fakePad, 'Xbox Wireless Controller (STANDARD GAMEPAD)');
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(`pad_${randomUUID().slice(0, 8)}`);
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('skip-test').click();
  await page.getByTestId('starter-4').click();
  await page.getByTestId('starter-ok').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-input', 'keyboard');

  // The d-pad moves the selection down the menu to the settings; A opens them.
  await press(page, DOWN);
  await expect(html).toHaveAttribute('data-input', 'gamepad');
  await expect(page.locator('.nav-focus')).toHaveCount(1);
  // The bar on Solo is the focus already: the first press goes on to Multiplayer.
  expect(await focusedId(page)).toBe('menu-lobby');
  for (let i = 0; i < 12 && (await focusedId(page)) !== 'menu-settings'; i++)
    await press(page, DOWN);
  expect(await focusedId(page)).toBe('menu-settings');
  if (shots) await page.screenshot({ path: `${shots}/menu-gamepad-focus.png` });
  await press(page, A);
  await expect(page.getByTestId('screen-settings')).toBeVisible();
  // Back buttons show B while the pad is in use; B goes back.
  const backGlyph = page.getByTestId('back').locator('.glyph');
  await expect(backGlyph).toBeVisible();
  await press(page, B);
  await expect(page.getByTestId('screen-menu')).toBeVisible();

  // The gacha: the selection bar on the first region is the focus, so the first press moves on
  // to the next (each region shows its banner). Right doesn't jump up to Back; up does.
  await page.goto('/#gacha');
  await expect(page.getByTestId('banner-kanto')).toHaveClass(/\bon\b/);
  await press(page, DOWN);
  expect(await focusedId(page)).toBe('banner-johto');
  await expect(page.getByTestId('banner-johto')).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('pity')).toContainText('Johto');
  await press(page, RIGHT);
  expect(await focusedId(page)).not.toBe('back');
  await press(page, UP);
  await press(page, UP);
  expect(await focusedId(page)).toBe('back');
  if (shots) await page.screenshot({ path: `${shots}/gacha-gamepad-focus.png` });
  await press(page, B);
  await expect(page.getByTestId('screen-menu')).toBeVisible();

  // A key switches the prompts back to keys.
  await page.keyboard.press('Shift');
  await expect(html).toHaveAttribute('data-input', 'keyboard');

  // In a run the pad plays: Start pauses, the d-pad moves through the pause menu, B resumes.
  await page.goto('/#solo');
  await page.getByTestId('solo-start').click();
  await expect(page.getByTestId('game-phase')).toHaveText('running', { timeout: 20_000 });
  await press(page, DOWN); // walking: no menu focus
  await expect(html).toHaveAttribute('data-input', 'gamepad');
  expect(await focusedId(page)).toBeNull();
  await press(page, START);
  const pause = page.getByTestId('pause');
  await expect(pause).toBeVisible();
  await expect(page.getByTestId('resume').locator('.glyph')).toBeVisible();
  await press(page, DOWN);
  await expect(pause.locator('.nav-focus')).toHaveCount(1);
  if (shots) await page.screenshot({ path: `${shots}/pause-gamepad.png` });
  await press(page, B);
  await expect(pause).toBeHidden();
  // The keyboard again: the pause menu shows keys.
  await page.keyboard.press('Escape');
  await expect(pause).toBeVisible();
  await expect(page.getByTestId('resume').locator('kbd')).toHaveText('Esc');
  await expect(page.getByTestId('resume').locator('.glyph')).toBeHidden();
});
