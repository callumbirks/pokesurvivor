// Solo crash-safety: a run saves itself locally from the start and every few seconds, and
// checkpoints to the server (every 2 s of run time in most cases here, through the dev-only
// `ps.dev.checkpointS` override, instead of every minute). After a reload the menu offers to
// resume it on the same run id, or to end it, crediting what it had.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

interface Checkpoint {
  runId: string;
  durationS: number;
}

interface SaveStats {
  stats: { runs: number; bestTimeS: number };
}

async function newPlayer(page: Page, opts: { fastCheckpoints?: boolean } = {}): Promise<void> {
  await page.goto('/');
  if (opts.fastCheckpoints !== false)
    await page.evaluate(() => localStorage.setItem('ps.dev.checkpointS', '2'));
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(`ash_${randomUUID().slice(0, 8)}`);
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  for (let i = 0; i < 8; i++) await page.getByTestId('answer-1').click();
  await page.getByTestId('starter-accept').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
}

/**
 * Plays until the server has stored a checkpoint at least `minS` seconds into the run (picking
 * the first card of any level-up: the run waits for it) and returns it.
 */
async function playUntilCheckpoint(page: Page, minS: number): Promise<Checkpoint> {
  for (;;) {
    const res = await page.waitForResponse((r) => r.url().endsWith('/api/runs/checkpoint'), {
      timeout: 30_000,
    });
    expect(res.status()).toBe(200);
    const body = res.request().postDataJSON() as Checkpoint;
    if (body.durationS >= minS) {
      // The local save is written as the checkpoint is sent; give IndexedDB a moment.
      await page.waitForTimeout(300);
      return body;
    }
  }
}

/** Picks level-up cards while the run plays, so it keeps advancing. */
function pickCards(page: Page): () => void {
  let on = true;
  void (async () => {
    while (on) {
      const card = page.getByTestId('option-0');
      if (await card.isVisible().catch(() => false)) await card.click().catch(() => {});
      await page.waitForTimeout(200).catch(() => {});
    }
  })();
  return () => (on = false);
}

async function save(page: Page): Promise<SaveStats> {
  return page.evaluate(() => fetch('/api/save').then((r) => r.json() as Promise<SaveStats>));
}

async function startRunAndReload(page: Page): Promise<Checkpoint> {
  await newPlayer(page);
  await page.getByTestId('menu-solo').click();
  await page.getByTestId('solo-start').click();
  await expect(page.getByTestId('game-phase')).toHaveText('running');
  const stop = pickCards(page);
  const checkpoint = await playUntilCheckpoint(page, 4);
  stop();
  // The tab goes away mid-run (a crash, a closed tab): nothing is reported.
  await page.reload();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  await expect(page.getByTestId('saved-run')).toBeVisible();
  expect((await save(page)).stats.runs).toBe(0);
  return checkpoint;
}

test('a reloaded solo run resumes on the same run and is credited once', async ({ page }) => {
  const before = await startRunAndReload(page);

  await page.getByTestId('saved-run-resume').click();
  await expect(page.getByTestId('screen-play')).toBeVisible();
  await expect(page.getByTestId('game-phase')).toHaveText('running');
  const stop = pickCards(page);
  // It goes on from where it was saved, on the same run id.
  const after = await playUntilCheckpoint(page, before.durationS + 2);
  stop();
  expect(after.runId).toBe(before.runId);

  await page.keyboard.press('Escape');
  await page.getByTestId('game-exit').click();
  await expect(page.getByTestId('results')).toBeVisible();
  await expect(page.getByTestId('not-credited')).toHaveCount(0);
  await page.getByTestId('game-exit').click();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  await expect(page.getByTestId('saved-run')).toBeHidden();

  const { stats } = await save(page);
  expect(stats.runs).toBe(1);
  expect(stats.bestTimeS).toBeGreaterThanOrEqual(after.durationS);
  // Nothing left to resume after another reload.
  await page.reload();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('saved-run')).toBeHidden();
});

test('ending a reloaded solo run credits what it had', async ({ page }) => {
  const checkpoint = await startRunAndReload(page);

  await page.getByTestId('saved-run-end').click();
  await expect(page.getByTestId('saved-run')).toBeHidden();
  const { stats } = await save(page);
  expect(stats.runs).toBe(1);
  // The local save is the latest checkpoint (or a little later, if the reload came between it
  // being saved and sent).
  expect(stats.bestTimeS).toBeGreaterThanOrEqual(checkpoint.durationS);

  await page.reload();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('saved-run')).toBeHidden();
  expect((await save(page)).stats.runs).toBe(1);
});

test('hiding the page pauses the solo run and checkpoints it', async ({ page }) => {
  await newPlayer(page);
  // Only the hide checkpoint should be sent: no run-time ones during this test.
  await page.evaluate(() => localStorage.setItem('ps.dev.checkpointS', '600'));
  await page.getByTestId('menu-solo').click();
  await page.getByTestId('solo-start').click();
  await expect(page.getByTestId('game-phase')).toHaveText('running');
  await page.waitForTimeout(1500);

  const setHidden = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { value: h, configurable: true });
      Object.defineProperty(document, 'visibilityState', {
        value: h ? 'hidden' : 'visible',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  // A phone switching apps: the run pauses and is checkpointed (and saved) at once.
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/runs/checkpoint'));
  await setHidden(true);
  const res = await sent;
  expect(res.status()).toBe(200);
  expect((res.request().postDataJSON() as Checkpoint).durationS).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('pause')).toBeVisible();

  // Back: still paused until the player continues.
  await setHidden(false);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('pause')).toBeVisible();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('pause')).toBeHidden();
});

test('a reload early in a run, before any server checkpoint, still offers to resume it', async ({
  page,
}) => {
  // The real cadence: no server checkpoint in the first minute of run time.
  await newPlayer(page, { fastCheckpoints: false });
  await page.getByTestId('menu-solo').click();
  const started = page.waitForResponse((r) => r.url().endsWith('/api/runs/start'));
  await page.getByTestId('solo-start').click();
  const { runId } = (await (await started).json()) as { runId: string };
  await expect(page.getByTestId('game-phase')).toHaveText('running');
  const stop = pickCards(page);
  await page.waitForTimeout(8000);
  stop();

  await page.reload();
  await expect(page.getByTestId('screen-menu')).toBeVisible();
  await expect(page.getByTestId('saved-run')).toBeVisible();
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/runs/checkpoint'));
  await page.getByTestId('saved-run-resume').click();
  // Resuming checks the run with a checkpoint of the saved run: the same run, a few seconds in.
  const resumed = (await sent).request().postDataJSON() as Checkpoint;
  expect(resumed.runId).toBe(runId);
  expect(resumed.durationS).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId('game-phase')).toHaveText('running');

  await page.keyboard.press('Escape');
  await page.getByTestId('game-exit').click();
  await expect(page.getByTestId('results')).toBeVisible();
  await expect(page.getByTestId('not-credited')).toHaveCount(0);
  const { stats } = await save(page);
  expect(stats.runs).toBe(1);
  expect(stats.bestTimeS).toBeGreaterThanOrEqual(resumed.durationS);
});
