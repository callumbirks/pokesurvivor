import type { FastifyBaseLogger } from 'fastify';
import type { Executor } from '../db/index.js';
import { creditTimedOutRuns } from './service.js';
import type { ProgressOptions } from './service.js';

export interface RunSweeperOptions extends ProgressOptions {
  db: Executor;
  log: FastifyBaseLogger;
  /** See `SoloRunConfig` in `config.ts`. */
  checkpointTimeoutMs: number;
  sweepIntervalMs: number;
}

/**
 * Credits timed-out solo runs from their last checkpoint (`creditTimedOutRuns`): once at start,
 * then every `sweepIntervalMs`. The state is all in the database, so runs that timed out while
 * the server was down are credited by the next instance, and several instances can sweep at
 * once.
 */
export class RunSweeper {
  readonly #opts: RunSweeperOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;

  constructor(opts: RunSweeperOptions) {
    this.#opts = opts;
  }

  start(): void {
    if (this.#timer) return;
    void this.sweep();
    this.#timer = setInterval(() => void this.sweep(), this.#opts.sweepIntervalMs);
    this.#timer.unref();
  }

  /** One pass (skipped if one is still running). Errors are logged, not thrown. */
  sweep(): Promise<void> {
    this.#running ??= (async () => {
      const { db, log, checkpointTimeoutMs, timeZone } = this.#opts;
      try {
        const ids = await creditTimedOutRuns(db, checkpointTimeoutMs, { timeZone });
        if (ids.length) log.info({ runs: ids }, 'credited timed-out solo runs');
      } catch (err) {
        log.error({ err }, 'solo run sweep failed');
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  /** Stops the timer and waits for a pass in progress. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }
}
