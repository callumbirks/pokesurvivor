// The network stats' mechanics: rolling windows, percentiles, gaps, rates and how the verdicts
// follow the thresholds. Thresholds are read from NETSTATS, never pinned here.
import { TICK_MS } from '@pokesurvivor/sim';
import { describe, expect, it } from 'vitest';
import {
  NETSTATS,
  NetStats,
  Rolling,
  median,
  percentile,
  verdict,
  type NetStatsSummary,
} from './netstats.js';

const W = NETSTATS.windowMs;

/**
 * Snapshots every `spacing` ticks (as the server sends them), arriving on time. Returns the last
 * arrival and the next tick.
 */
function steady(s: NetStats, from: number, to: number, spacing = 2) {
  let tick = 1;
  let at = from;
  for (; at + spacing * TICK_MS <= to; at += spacing * TICK_MS, tick += spacing)
    s.snapshot(at, tick, false);
  s.snapshot(at, tick, false);
  return { at, tick: tick + spacing };
}

describe('rolling stats', () => {
  it('median and percentile (nearest rank)', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([], 0.95)).toBeNull();
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(percentile(hundred, 0.95)).toBe(95);
    expect(percentile(hundred, 1)).toBe(100);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it('keeps only the samples inside the window', () => {
    const r = new Rolling<number>(1000);
    r.add(0, 1);
    r.add(500, 2);
    r.add(1200, 3);
    expect(r.values(1200)).toEqual([2, 3]);
    expect(r.values(2300)).toEqual([]);
  });

  it('RTT: current, median and p95 over the window', () => {
    const s = new NetStats();
    for (let i = 0; i < 20; i++) s.rtt(i * 500, i === 19 ? 300 : 20 + i);
    const sum = s.summary(19 * 500);
    expect(sum.rtt.current).toBe(300);
    expect(sum.rtt.median).toBe(median([...Array.from({ length: 19 }, (_, i) => 20 + i), 300]));
    expect(sum.rtt.p95).toBe(38);
    // Older samples leave the window.
    expect(s.summary(19 * 500 + W + 1).rtt.median).toBeNull();
    s.disconnected();
    expect(s.summary(19 * 500).rtt.current).toBeNull();
  });

  it('snapshot rate, the largest gap and jitter', () => {
    const s = new NetStats();
    const { at: last, tick } = steady(s, 0, 4000);
    const onTime = s.summary(last);
    expect(onTime.snapshots.perSecond).toBeCloseTo(1000 / (2 * TICK_MS), 0);
    expect(onTime.snapshots.jitterMs).toBeCloseTo(0, 5);
    expect(onTime.snapshots.maxGapMs).toBeCloseTo(2 * TICK_MS, 5);

    // One late snapshot: a gap, then the next one close behind (jitter both ways).
    s.snapshot(last + 300, tick, false);
    s.snapshot(last + 310, tick + 2, false);
    const late = s.summary(last + 320);
    expect(late.snapshots.maxGapMs).toBeCloseTo(300, 5);
    expect(late.snapshots.jitterMs).toBeGreaterThan(0);
    // A stall counts while it lasts.
    expect(s.summary(last + 1310).snapshots.maxGapMs).toBeCloseTo(1000, 5);
  });

  it('the server spacing (1 or 2 ticks) is not jitter', () => {
    const s = new NetStats();
    let at = 0;
    let tick = 0;
    for (let i = 0; i < 100; i++) {
      const step = i % 2 ? 1 : 2;
      tick += step;
      at += step * TICK_MS;
      s.snapshot(at, tick, false);
    }
    expect(s.summary(at).snapshots.jitterMs).toBeCloseTo(0, 5);
  });

  it('paused snapshots (1/s on purpose) and restarts are not gaps', () => {
    const s = new NetStats();
    const { tick } = steady(s, 0, 1000);
    s.snapshot(1100, tick, true);
    s.snapshot(2100, tick + 30, true);
    s.snapshot(3100, tick + 60, true);
    expect(s.summary(3100).snapshots.maxGapMs).toBeCloseTo(2 * TICK_MS, 5);
    expect(s.summary(3900).snapshots.maxGapMs).toBeCloseTo(2 * TICK_MS, 5);
    // A new game: the wait since the last one's snapshots isn't a gap.
    s.restart();
    s.snapshot(5000, 1, false);
    expect(s.summary(5000).snapshots.maxGapMs).toBeCloseTo(2 * TICK_MS, 5);
  });

  it('rates divide by the time since the first sample until the window is full', () => {
    const s = new NetStats();
    steady(s, 0, 1000, 3);
    expect(s.summary(1000).snapshots.perSecond).toBeCloseTo(11, 0);
  });

  it('corrections: count and largest, ignoring rounding', () => {
    const s = new NetStats();
    s.correction(0, NETSTATS.correctionMin / 2);
    s.correction(100, 4);
    s.correction(200, 12.5);
    expect(s.summary(300).corrections).toEqual({ count: 2, maxUnits: 12.5 });
    expect(s.summary(100 + W + 1).corrections).toEqual({ count: 1, maxUnits: 12.5 });
    expect(s.summary(200 + W + 1).corrections).toEqual({ count: 0, maxUnits: 0 });
  });

  it('frames: FPS over the last second, the worst frame and slow ones in the window', () => {
    const s = new NetStats();
    let at = 0;
    for (let i = 0; i < 300; i++) s.frame((at += 1000 / 60), 1000 / 60);
    s.frame((at += NETSTATS.slowFrameMs * 2), NETSTATS.slowFrameMs * 2);
    for (let i = 0; i < 120; i++) s.frame((at += 1000 / 60), 1000 / 60);
    const sum = s.summary(at);
    expect(sum.frames.fps).toBeCloseTo(60, 0);
    expect(sum.frames.worstMs).toBe(NETSTATS.slowFrameMs * 2);
    expect(sum.frames.slow).toBe(1);
    // A hidden tab's pause isn't a hitch.
    s.frame((at += NETSTATS.ignoreFrameMs + 1), NETSTATS.ignoreFrameMs + 1);
    expect(s.summary(at).frames.worstMs).toBe(NETSTATS.slowFrameMs * 2);
  });

  it('server lag adds up over the window', () => {
    const s = new NetStats();
    s.serverLag(0, { late: 2, skipped: 0, worstMs: 40 });
    s.serverLag(1000, { late: 1, skipped: 1, worstMs: 180 });
    expect(s.summary(1000).server).toEqual({ late: 3, skipped: 1, worstMs: 180 });
    expect(s.summary(1000 + W + 1).server).toEqual({ late: 0, skipped: 0, worstMs: 0 });
  });

  it('passes the connection input counts through', () => {
    const s = new NetStats();
    expect(s.summary(0, { perSecond: 8, unacked: 2 }).inputs).toEqual({
      perSecond: 8,
      unacked: 2,
    });
  });
});

/** A summary where everything is fine, to change one thing at a time. */
function fine(): NetStatsSummary {
  const n = NETSTATS.network.jittery;
  return {
    rtt: { current: 1, median: 1, p95: n.rttP95Ms - 1 },
    snapshots: { perSecond: 20, maxGapMs: n.gapMs - 1, jitterMs: n.jitterMs - 1 },
    inputs: { perSecond: 8, unacked: 1 },
    corrections: { count: 0, maxUnits: 0 },
    frames: { fps: NETSTATS.browser.minFps + 1, worstMs: NETSTATS.browser.worstFrameMs, slow: 0 },
    server: {
      late: NETSTATS.server.lateTicks - 1,
      skipped: 0,
      worstMs: NETSTATS.server.worstMs - 1,
    },
  };
}

describe('verdicts', () => {
  it('all fine', () => {
    expect(verdict(fine())).toEqual({ network: 'good', browser: 'smooth', server: 'ok' });
  });

  it('nothing measured yet: no network or browser verdict', () => {
    const s = new NetStats().summary(0);
    expect(verdict(s)).toEqual({ network: null, browser: null, server: 'ok' });
  });

  it('network: each jittery threshold, then each poor one', () => {
    const j = NETSTATS.network.jittery;
    const p = NETSTATS.network.poor;
    const with_ = (f: (s: NetStatsSummary) => void) => {
      const s = fine();
      f(s);
      return verdict(s).network;
    };
    expect(with_((s) => (s.rtt.p95 = j.rttP95Ms + 1))).toBe('jittery');
    expect(with_((s) => (s.snapshots.maxGapMs = j.gapMs + 1))).toBe('jittery');
    expect(with_((s) => (s.snapshots.jitterMs = j.jitterMs + 1))).toBe('jittery');
    expect(with_((s) => (s.rtt.median = p.rttMedianMs + 1))).toBe('poor');
    expect(with_((s) => (s.snapshots.maxGapMs = p.gapMs + 1))).toBe('poor');
    expect(with_((s) => (s.snapshots.jitterMs = p.jitterMs + 1))).toBe('poor');
  });

  it('browser: low FPS or a long frame', () => {
    const b = NETSTATS.browser;
    const low = fine();
    low.frames.fps = b.minFps - 1;
    expect(verdict(low).browser).toBe('dropping');
    const long = fine();
    long.frames.worstMs = b.worstFrameMs + 1;
    expect(verdict(long).browser).toBe('dropping');
  });

  it('server: any skip, enough late ticks, or far enough behind', () => {
    const sv = NETSTATS.server;
    const skip = fine();
    skip.server.skipped = 1;
    expect(verdict(skip).server).toBe('struggling');
    const late = fine();
    late.server.late = sv.lateTicks;
    expect(verdict(late).server).toBe('struggling');
    const behind = fine();
    behind.server.worstMs = sv.worstMs;
    expect(verdict(behind).server).toBe('struggling');
  });
});
