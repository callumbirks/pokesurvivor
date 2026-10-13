// Solo crash-safety: a run checkpoints while it plays (every 2 s of run time here, through the
// dev-only `ps.dev.checkpointS` override, instead of every minute) and saves itself locally. After
// a reload the menu offers to resume it on the same run id, or to end it, crediting what it had.
import { expect, test, type Page } from '@playwright/test';

interface Checkpoint {
  runId: string;
  durationS: number;
}

interface SaveStats {
  stats: { runs: number; bestTimeS: number };
}

async function newPlayer(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('ps.dev.checkpointS', '2'));
  await page.getByTestId('tab-register').click();
  await page.getByTestId('login-username').fill(`ash_${Date.now().toString(36).slice(-7)}`);
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
