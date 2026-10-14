// Auto / manual aim in the real client: T and the HUD button switch it (remembered), the mouse
// aims on desktop, twin sticks on a phone (the aim stays when the right thumb lifts), in solo and
// in coop. The sim's aim for us comes back in the snapshots (`serverAim`), so these check that the
// sim (the solo worker or the game server) aims where we point. E2E_SHOTS=<dir> saves screenshots.
import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';

const suffix = randomUUID().slice(0, 8);
const shots = process.env.E2E_SHOTS;

interface Counts {
  aim: number | null;
  serverAim: number | null;
  self: [number, number] | null;
  fire: boolean;
}

const counts = (page: Page) =>
  page.evaluate<Counts | null>(
    () => (window as unknown as { __psCounts?: Counts }).__psCounts ?? null,
  );

const gap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

async function newPlayer(
  browser: Browser,
  name: string,
  options: BrowserContextOptions = {},
): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(name);
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('screen-starter')).toBeVisible();
  await page.getByTestId('skip-test').click();
  // Charmander: Ember, a projectile.
  await page.getByTestId('starter-4').click();
  await page.getByTestId('starter-ok').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  return page;
}

async function playSolo(page: Page): Promise<void> {
  await page.goto('/#solo');
  await page.getByTestId('solo-start').click();
  await expect(page.getByTestId('game-phase')).toHaveText('running', { timeout: 20_000 });
  await expect.poll(async () => (await counts(page))?.self ?? null).not.toBeNull();
}

const storedMode = (page: Page) =>
  page.evaluate(
    () => (JSON.parse(localStorage.getItem('ps.settings') ?? '{}') as { aimMode?: string }).aimMode,
  );

/** Points the mouse `dx, dy` from our Pokémon and waits until we and the sim aim that way. */
async function mouseAim(page: Page, dx: number, dy: number): Promise<[number, number]> {
  const self = (await counts(page))?.self;
  if (!self) throw new Error('no self');
  const box = (await page.getByTestId('game').locator('canvas').boundingBox())!;
  const at: [number, number] = [box.x + self[0] + dx, box.y + self[1] + dy];
  await page.mouse.move(at[0], at[1], { steps: 4 });
  const want = Math.atan2(dy, dx);
  await expect.poll(async () => gap((await counts(page))?.aim ?? 99, want)).toBeLessThan(0.1);
  await expect.poll(async () => gap((await counts(page))?.serverAim ?? 99, want)).toBeLessThan(0.1);
  return at;
}

/** The colour drawn at the crosshair's centre dot for a cursor at page point `at` ("#rrggbb"). */
const crosshairColour = (page: Page, at: [number, number]) =>
  page.locator('canvas.ps-canvas').evaluate((c: HTMLCanvasElement, [x, y]) => {
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    // The dot covers the 2 × 2 CSS px up and left of the rounded cursor point.
    const px = (Math.round(x - r.left) - 0.5) * k;
    const py = (Math.round(y - r.top) - 0.5) * k;
    const d = c.getContext('2d')!.getImageData(Math.floor(px), Math.floor(py), 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
  }, at);

test('desktop: T and the HUD button switch the aim; the mouse aims and fires', async ({
  browser,
}) => {
  const page = await newPlayer(browser, `aim_${suffix}`, {
    viewport: { width: 1280, height: 720 },
  });
  await playSolo(page);
  expect((await counts(page))?.aim).toBeNull();

  await page.keyboard.press('KeyT');
  await expect.poll(() => storedMode(page)).toBe('manual');
  await mouseAim(page, 220, 0);
  await mouseAim(page, 0, -160);
  const at = await mouseAim(page, -150, 120);
  // The crosshair is magenta by default.
  await expect.poll(() => crosshairColour(page, at)).toBe('#ff00ff');
  // Holding the left button over the game fires; releasing stops. The crosshair keeps its colour.
  await page.mouse.down();
  await expect.poll(async () => (await counts(page))?.fire).toBe(true);
  await page.waitForTimeout(150);
  expect(await crosshairColour(page, at)).toBe('#ff00ff');
  // The crosshair replaces the system cursor over the game.
  expect(await page.locator('canvas.ps-canvas').evaluate((c) => getComputedStyle(c).cursor)).toBe(
    'none',
  );
  if (shots) await page.screenshot({ path: `${shots}/desktop-manual.png` });
  await page.mouse.up();
  await expect.poll(async () => (await counts(page))?.fire).toBe(false);

  // The HUD button (top right) goes back to auto.
  await page.mouse.click(1280 - 40, 62);
  await expect.poll(() => storedMode(page)).toBe('auto');
  await expect.poll(async () => (await counts(page))?.aim).toBeNull();
  if (shots) await page.screenshot({ path: `${shots}/desktop-auto.png` });

  // A 1920 × 1080 window draws the HUD at 1.5×: its buttons are hit where they're drawn now.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(300); // a frame drawn at the new size registers the buttons
  await page.mouse.click(1920 - 40 * 1.5, 62 * 1.5);
  await expect.poll(() => storedMode(page)).toBe('manual');
  // Holding the button over a move slot doesn't fire: at 1.5× the slot spans y 972–1053 (at 1×
  // it would be 1008–1062), so this point is on it only where it's drawn now.
  await page.mouse.move(960, 985);
  await page.mouse.down();
  await page.waitForTimeout(300);
  expect((await counts(page))?.fire).toBe(false);
  await page.mouse.up();

  // The settings list the key and offer the choice, and the HUD size.
  await page.keyboard.press('Escape');
  await page.getByTestId('pause-settings').click();
  await page.getByTestId('set-tab-controls').click();
  await expect(page.getByTestId('screen-settings')).toContainText('Switch aiming');
  await page.getByTestId('set-aim-manual').click();
  await expect.poll(() => storedMode(page)).toBe('manual');
  // The crosshair colour: magenta is chosen; pick cyan (the tab redraws with it chosen).
  await expect(page.getByTestId('set-crosshair-magenta')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('set-crosshair-cyan').click();
  await expect(page.getByTestId('set-crosshair-cyan')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('set-crosshair-magenta')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('set-crosshair-cyan')).toHaveAccessibleName('Cyan');
  // And its size: 1× by default, set to 1.5× (it's a slider: the screen doesn't redraw).
  const xhair = page.getByTestId('set-crosshairScale');
  await xhair.fill('1.5');
  await expect(xhair.locator('xpath=following-sibling::span')).toHaveText('×1.5');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (JSON.parse(localStorage.getItem('ps.settings') ?? '{}') as { crosshairScale?: number })
            .crosshairScale,
      ),
    )
    .toBe(1.5);
  if (shots) await page.screenshot({ path: `${shots}/settings-crosshair.png` });
  await page.getByTestId('set-tab-graphics').click();
  // HUD size: Auto by default (1.5× here), dragged to a fixed size, back to Auto.
  const hudSize = () =>
    page.evaluate(
      () =>
        (JSON.parse(localStorage.getItem('ps.settings') ?? '{}') as { hudSize?: number | 'auto' })
          .hudSize ?? 'auto',
    );
  const auto = page.getByTestId('set-hudSize-auto');
  await expect(auto).toHaveText('Auto (150%)');
  const range = page.getByTestId('set-hudSize');
  const node = await range.elementHandle();
  /** Drags the slider's thumb from `from` to `to` (0–1 along the track) in small steps. */
  const drag = async (from: number, to: number) => {
    const box = (await range.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * from, y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++)
      await page.mouse.move(box.x + box.width * (from + ((to - from) * i) / 12), y);
    await page.mouse.up();
  };
  // A drag goes all the way (a redraw mid-drag used to stop it after one step)...
  await drag(0.6, 1);
  await expect.poll(hudSize).toBe(2);
  await expect(auto).toHaveText('Auto');
  // ...on the same input element, which keeps working.
  expect(
    await node.evaluate(
      (el) => el.isConnected && el === document.querySelector('[data-testid=set-hudSize]'),
    ),
  ).toBe(true);
  await drag(0.97, 0);
  await expect.poll(hudSize).toBe(0.75);
  await auto.click();
  await expect.poll(hudSize).toBe('auto');
  await expect(auto).toHaveText('Auto (150%)');
  await drag(0.6, 0.2);
  // Off Auto again, at about a fifth of the way along (the thumb's width shifts it a little).
  await expect
    .poll(async () => {
      const v = await hudSize();
      return typeof v === 'number' && v >= 0.85 && v <= 1.1;
    })
    .toBe(true);
  expect(await node.evaluate((el) => el.isConnected)).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/settings-controls.png` });

  // Back in the game the crosshair is cyan, held or not.
  await page.getByTestId('back').click();
  await page.getByTestId('resume').click();
  const at2 = await mouseAim(page, 200, -100);
  await expect.poll(() => crosshairColour(page, at2)).toBe('#22e6ff');
  if (shots) await page.screenshot({ path: `${shots}/crosshair-cyan.png` });
  await page.mouse.down();
  await page.waitForTimeout(150);
  expect(await crosshairColour(page, at2)).toBe('#22e6ff');
  await page.mouse.up();
  await page.context().close();
});

test('phone: the HUD button and twin sticks; the aim stays when the thumb lifts', async ({
  browser,
}) => {
  const W = 844;
  const H = 390;
  const page = await newPlayer(browser, `thumb_${suffix}`, {
    viewport: { width: W, height: H },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  await playSolo(page);
  // The AIM button sits under the pause button, top right.
  await page.touchscreen.tap(W - 50, 74);
  await expect.poll(() => storedMode(page)).toBe('manual');

  // Left thumb walks right, right thumb aims up and to the left.
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  await touch('touchStart', [
    [150, 290],
    [680, 280],
  ]);
  for (let i = 1; i <= 6; i++)
    await touch('touchMove', [
      [150 + i * 6, 290],
      [680 - i * 7, 280 - i * 6],
    ]);
  const want = Math.atan2(-36, -42);
  await expect.poll(async () => gap((await counts(page))?.aim ?? 99, want)).toBeLessThan(0.1);
  await expect.poll(async () => gap((await counts(page))?.serverAim ?? 99, want)).toBeLessThan(0.1);
  if (shots) await page.screenshot({ path: `${shots}/phone-twin-sticks.png` });
  await touch('touchEnd', []);
  // Lifted: the aim stays.
  await page.waitForTimeout(400);
  expect(gap((await counts(page))?.aim ?? 99, want)).toBeLessThan(0.1);
  expect(gap((await counts(page))?.serverAim ?? 99, want)).toBeLessThan(0.1);
  if (shots) await page.screenshot({ path: `${shots}/phone-released.png` });
  await page.context().close();
});

test('coop: one player aims by hand, the server follows', async ({ browser }) => {
  const a = `aimer_${suffix}`;
  const b = `auto_${suffix}`;
  const pa = await newPlayer(browser, a, { viewport: { width: 1280, height: 720 } });
  const pb = await newPlayer(browser, b);
  await pa.getByTestId('menu-friends').click();
  await pa.getByTestId('friend-name').fill(b);
  await pa.getByTestId('friend-add').click();
  await pb.getByTestId('menu-friends').click();
  await pb.getByTestId(`accept-${a}`).click();
  await pa.getByTestId('back').click();
  await pa.getByTestId('menu-lobby').click();
  await pa.getByTestId('room-create').click();
  await pa.getByTestId(`invite-${b}`).click();
  await pb.getByTestId('invite-accept').click();
  await pa.getByTestId('room-ready').click();
  await pb.getByTestId('room-ready').click();
  await pa.getByTestId('room-start').click();
  for (const page of [pa, pb])
    await expect(page.getByTestId('game-phase')).toHaveText('running', { timeout: 20_000 });
  await expect.poll(async () => (await counts(pa))?.self ?? null).not.toBeNull();

  await pa.keyboard.press('KeyT');
  await mouseAim(pa, 200, 60);
  await mouseAim(pa, -120, -200);
  if (shots) await pa.screenshot({ path: `${shots}/coop-manual.png` });
  // B is still on auto.
  expect((await counts(pb))?.aim).toBeNull();
  await pa.context().close();
  await pb.context().close();
});
