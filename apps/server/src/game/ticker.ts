import { performance } from 'node:perf_hooks';

export interface TickerOptions {
  tickMs: number;
  onTick: () => void;
  /** When behind (a GC pause, a blocked event loop), run at most this many ticks at once… */
  maxCatchUp?: number;
  /** …and if still further behind, skip ahead instead of fast-forwarding. */
  onSkip?: (skippedMs: number) => void;
  /** A tick ran more than one tick late (the loop fell behind; it catches up). */
  onLate?: (lateMs: number) => void;
  now?: () => number;
}

/**
 * A fixed-rate timer that doesn't drift: each tick is scheduled against an absolute target time
 * (`start + n × tickMs`) rather than "tickMs after the last one", so timer lateness doesn't add
 * up. Late ticks are caught up, a few at a time.
 */
export class Ticker {
  private next = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly maxCatchUp: number;

  constructor(private readonly opts: TickerOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.maxCatchUp = opts.maxCatchUp ?? 5;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.next = this.now() + this.opts.tickMs;
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.run(), Math.max(0, this.next - this.now()));
  }

  private run(): void {
    const { tickMs } = this.opts;
    const late = this.now() - this.next;
    if (late >= tickMs) this.opts.onLate?.(late);
    let n = 0;
    while (this.now() >= this.next && n < this.maxCatchUp) {
      this.next += tickMs;
      n++;
      this.opts.onTick();
      if (!this.timer) return; // stopped from onTick
    }
    const behind = this.now() - this.next;
    if (behind > tickMs) {
      this.opts.onSkip?.(behind);
      this.next = this.now() + tickMs;
    }
    this.schedule();
  }
}
