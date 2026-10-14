// The in-game network stats (Settings → "Show network stats", or `?netstats`): rolling numbers
// over the last ten seconds, and a verdict saying whether hitches come from the network, the
// browser or the server. DOM-free: `netstats-ui.ts` draws it. The collector is fed as things
// happen (RTT samples, snapshot arrivals, input sends, prediction corrections, frames and the
// server's `server.lag`) and `summary()` turns that into numbers a few times a second.
//
// Every threshold is in `NETSTATS`, so tuning them is one edit.
import { TICK_MS } from '@pokesurvivor/sim';

export const NETSTATS = {
  /** The rolling window for everything below (ms). */
  windowMs: 10_000,
  /** How often the overlay redraws (ms): 4 Hz. */
  refreshMs: 250,
  /** A snapshot gap over this is highlighted (ms). */
  gapWarnMs: 150,
  /** A prediction correction under this is rounding, not a correction (world units). */
  correctionMin: 1,
  /** The largest correction is highlighted from this size (world units; ~one tick of a fast
   * Pokémon's movement). */
  correctionWarn: 10,
  /** A frame over this is a dropped frame (ms). */
  slowFrameMs: 50,
  /** Frames over this are a hidden tab or a debugger, not a hitch: ignored (ms). */
  ignoreFrameMs: 2000,
  network: {
    /** Over any of these: jittery. */
    jittery: { rttP95Ms: 150, gapMs: 250, jitterMs: 40 },
    /** Over any of these: poor. */
    poor: { rttMedianMs: 250, gapMs: 600, jitterMs: 100 },
  },
  browser: {
    /** Under this FPS, or a frame over `worstFrameMs`: dropping frames. */
    minFps: 40,
    worstFrameMs: 100,
  },
  server: {
    /** Any skip, this many late ticks, or this much behind in the window: struggling. */
    lateTicks: 3,
    worstMs: 100,
  },
} as const;

export type NetworkVerdict = 'good' | 'jittery' | 'poor';
export type BrowserVerdict = 'smooth' | 'dropping';
export type ServerVerdict = 'ok' | 'struggling';

export interface NetStatsSummary {
  rtt: { current: number | null; median: number | null; p95: number | null };
  snapshots: {
    /** Arrivals per second over the window. */
    perSecond: number;
    /** The longest wait between two snapshots (including the current one) while running (ms). */
    maxGapMs: number | null;
    /** p95 of how far each arrival strayed from the server's tick spacing (ms). */
    jitterMs: number | null;
  };
  inputs: { perSecond: number | null; unacked: number | null };
  corrections: { count: number; maxUnits: number };
  frames: { fps: number | null; worstMs: number | null; slow: number };
  server: { late: number; skipped: number; worstMs: number };
}

export interface NetStatsVerdict {
  network: NetworkVerdict | null;
  browser: BrowserVerdict | null;
  server: ServerVerdict;
}

/** The value at fraction `p` (0–1) of `values` (nearest rank); null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

export const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Timestamped samples kept for `windowMs`. */
export class Rolling<T> {
  private items: { at: number; value: T }[] = [];
  constructor(private readonly windowMs: number) {}

  add(at: number, value: T): void {
    // Pruned here too: nothing reads the samples while the panel is hidden.
    this.prune(at);
    this.items.push({ at, value });
  }

  /** The samples within the window ending at `now`, oldest first. */
  values(now: number): T[] {
    this.prune(now);
    return this.items.map((i) => i.value);
  }

  private prune(now: number): void {
    const from = now - this.windowMs;
    let drop = 0;
    while (drop < this.items.length && this.items[drop]!.at < from) drop++;
    if (drop) this.items.splice(0, drop);
  }

  clear(): void {
    this.items = [];
  }
}

interface Arrival {
  at: number;
  tick: number;
  /** Paused snapshots come slower on purpose (1/s while unchanged): not a gap. */
  paused: boolean;
}

export class NetStats {
  private readonly rtts: Rolling<number>;
  private readonly arrivals: Rolling<Arrival>;
  private readonly corrections: Rolling<number>;
  private readonly frames: Rolling<number>;
  private readonly lags: Rolling<{ late: number; skipped: number; worstMs: number }>;
  private rttNow: number | null = null;
  private lastArrival: Arrival | null = null;
  /** Gaps and spacing deviations between running snapshots (ms). */
  private readonly gaps: Rolling<{ gap: number; jitter: number }>;
  /** The first sample: rates divide by the time since, until a whole window has passed. */
  private since: number | null = null;

  constructor(private readonly windowMs: number = NETSTATS.windowMs) {
    this.rtts = new Rolling(windowMs);
    this.arrivals = new Rolling(windowMs);
    this.corrections = new Rolling(windowMs);
    this.frames = new Rolling(windowMs);
    this.lags = new Rolling(windowMs);
    this.gaps = new Rolling(windowMs);
  }

  rtt(at: number, ms: number): void {
    this.since ??= at;
    this.rttNow = ms;
    this.rtts.add(at, ms);
  }

  /** The connection dropped: the current RTT is unknown, and the gap across it isn't jitter. */
  disconnected(): void {
    this.rttNow = null;
    this.lastArrival = null;
  }

  snapshot(at: number, tick: number, paused: boolean): void {
    this.since ??= at;
    const a = { at, tick, paused };
    const prev = this.lastArrival;
    if (prev && !prev.paused && !paused && tick > prev.tick) {
      const gap = at - prev.at;
      this.gaps.add(at, { gap, jitter: Math.abs(gap - (tick - prev.tick) * TICK_MS) });
    }
    this.arrivals.add(at, a);
    this.lastArrival = a;
  }

  /** A run started or resumed: the gap since the last game's snapshots isn't one. */
  restart(): void {
    this.lastArrival = null;
  }

  /** A prediction correction of `units` world units (`Predictor.onCorrection`). */
  correction(at: number, units: number): void {
    if (units >= NETSTATS.correctionMin) this.corrections.add(at, units);
  }

  /** A rendered frame that took `ms`. */
  frame(at: number, ms: number): void {
    this.since ??= at;
    if (ms > 0 && ms <= NETSTATS.ignoreFrameMs) this.frames.add(at, ms);
  }

  serverLag(at: number, lag: { late: number; skipped: number; worstMs: number }): void {
    this.lags.add(at, lag);
  }

  /** The numbers as of `now`, with the connection's input counts (null: it has none). */
  summary(
    now: number,
    inputs: { perSecond: number | null; unacked: number | null } = {
      perSecond: null,
      unacked: null,
    },
  ): NetStatsSummary {
    const span = Math.max(1, Math.min(this.windowMs, now - (this.since ?? now)));
    const rtts = this.rtts.values(now);
    const arrivals = this.arrivals.values(now);
    const gaps = this.gaps.values(now);
    // The wait for the next snapshot so far counts too: a stall shows while it lasts.
    const last = this.lastArrival;
    const waiting = last && !last.paused ? now - last.at : 0;
    const maxGap = gaps.length || waiting ? Math.max(waiting, ...gaps.map((g) => g.gap)) : null;
    const frames = this.frames.values(now);
    // FPS over the last second (the window's average would hide a slow patch for ten seconds).
    let n = 0;
    let recent = 0;
    for (let i = frames.length - 1; i >= 0 && recent < 1000; i--, n++) recent += frames[i]!;
    const lags = this.lags.values(now);
    const corrections = this.corrections.values(now);
    return {
      rtt: { current: this.rttNow, median: median(rtts), p95: percentile(rtts, 0.95) },
      snapshots: {
        perSecond: (arrivals.length * 1000) / span,
        maxGapMs: maxGap,
        jitterMs: percentile(
          gaps.map((g) => g.jitter),
          0.95,
        ),
      },
      inputs,
      corrections: { count: corrections.length, maxUnits: Math.max(0, ...corrections) },
      frames: {
        fps: n ? (n * 1000) / recent : null,
        worstMs: frames.length ? Math.max(...frames) : null,
        slow: frames.filter((f) => f > NETSTATS.slowFrameMs).length,
      },
      server: {
        late: lags.reduce((a, l) => a + l.late, 0),
        skipped: lags.reduce((a, l) => a + l.skipped, 0),
        worstMs: Math.max(0, ...lags.map((l) => l.worstMs)),
      },
    };
  }
}

/** The verdict line. Null: not enough samples yet. */
export function verdict(s: NetStatsSummary): NetStatsVerdict {
  const n = NETSTATS.network;
  let network: NetworkVerdict | null = null;
  if (s.rtt.median !== null || s.snapshots.maxGapMs !== null) {
    const over = (v: number | null, limit: number) => v !== null && v > limit;
    if (
      over(s.rtt.median, n.poor.rttMedianMs) ||
      over(s.snapshots.maxGapMs, n.poor.gapMs) ||
      over(s.snapshots.jitterMs, n.poor.jitterMs)
    )
      network = 'poor';
    else if (
      over(s.rtt.p95, n.jittery.rttP95Ms) ||
      over(s.snapshots.maxGapMs, n.jittery.gapMs) ||
      over(s.snapshots.jitterMs, n.jittery.jitterMs)
    )
      network = 'jittery';
    else network = 'good';
  }
  const b = NETSTATS.browser;
  const browser: BrowserVerdict | null =
    s.frames.fps === null
      ? null
      : s.frames.fps < b.minFps || (s.frames.worstMs ?? 0) > b.worstFrameMs
        ? 'dropping'
        : 'smooth';
  const sv = NETSTATS.server;
  const server: ServerVerdict =
    s.server.skipped > 0 || s.server.late >= sv.lateTicks || s.server.worstMs >= sv.worstMs
      ? 'struggling'
      : 'ok';
  return { network, browser, server };
}
