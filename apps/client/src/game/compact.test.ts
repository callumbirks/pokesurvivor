// @vitest-environment happy-dom
// Long-lived notices pop up in full, shrink into a chip after a moment, and expand again only for
// something to act on (a final notice, a Reload button): in the game's toasts and the app shell.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../settings.js';
import { h } from '../app/dom.js';
import { mountToasts, notice, noticeIsCompact } from '../app/toast.js';
import { COMPACT_AFTER_MS } from './compact.js';
import { Toasts } from './toasts.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  settings.set({ calmMode: false });
});

describe('game notices: big, then a chip', () => {
  const setup = () => new Toasts(document.createElement('div'));
  const node = (t: Toasts, key: string) =>
    t.root.querySelector<HTMLElement>(`[data-key="${key}"]`)!;

  it('shrink into the chip after COMPACT_AFTER_MS, and keep the live text in short', () => {
    const t = setup();
    t.set(
      'draining',
      'Server update in 0:30 · your run will continue right after',
      'warn',
      'Update 0:30',
    );
    expect(t.isCompact('draining')).toBe(false);
    expect(node(t, 'draining').textContent).toContain('your run will continue');
    vi.advanceTimersByTime(COMPACT_AFTER_MS - 1);
    // A countdown tick doesn't restart the timer.
    t.set(
      'draining',
      'Server update in 0:27 · your run will continue right after',
      'warn',
      'Update 0:27',
    );
    expect(t.isCompact('draining')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.isCompact('draining')).toBe(true);
    expect(node(t, 'draining').classList.contains('compact')).toBe(true);
    expect(node(t, 'draining').textContent).toBe('Update 0:27');
    t.set(
      'draining',
      'Server update in 0:21 · your run will continue right after',
      'warn',
      'Update 0:21',
    );
    expect(node(t, 'draining').textContent).toBe('Update 0:21');
    // Still a chip however long it ticks down: no re-expanding near the end.
    vi.advanceTimersByTime(30_000);
    t.set(
      'draining',
      'Server update in 0:03 · your run will continue right after',
      'warn',
      'Update 0:03',
    );
    expect(t.isCompact('draining')).toBe(true);
  });

  it('expand again only for a notice without a chip (connection lost for good)', () => {
    const t = setup();
    t.set('connection', 'Connection lost: reconnecting…', 'warn', 'Reconnecting…');
    vi.advanceTimersByTime(COMPACT_AFTER_MS);
    expect(node(t, 'connection').textContent).toBe('Reconnecting…');
    // Reconnecting for a long time: still the chip.
    vi.advanceTimersByTime(60_000);
    t.set('connection', 'Connection lost: reconnecting…', 'warn', 'Reconnecting…');
    expect(t.isCompact('connection')).toBe(true);
    t.set('connection', 'Connection lost.', 'warn');
    expect(t.isCompact('connection')).toBe(false);
    expect(node(t, 'connection').classList.contains('compact')).toBe(false);
    expect(node(t, 'connection').textContent).toBe('Connection lost.');
    vi.advanceTimersByTime(COMPACT_AFTER_MS * 3);
    expect(t.isCompact('connection')).toBe(false);
  });

  it('starts over in full when it comes back after being cleared', () => {
    const t = setup();
    t.set('connection', 'Connection lost: reconnecting…', 'warn', 'Reconnecting…');
    vi.advanceTimersByTime(COMPACT_AFTER_MS);
    t.clear('connection');
    t.set('connection', 'Connection lost: reconnecting…', 'warn', 'Reconnecting…');
    expect(t.isCompact('connection')).toBe(false);
  });

  it("doesn't animate the shrink in calm mode", () => {
    settings.set({ calmMode: true });
    const t = setup();
    t.set('hold', 'Waiting for ash · 0:42', 'info', 'Waiting 0:42');
    vi.advanceTimersByTime(COMPACT_AFTER_MS);
    expect(node(t, 'hold').classList.contains('calm')).toBe(true);
    expect(node(t, 'hold').classList.contains('compact')).toBe(true);
  });
});

describe('shell notices: big, then a chip', () => {
  mountToasts(document.body);
  const el = (id: string) => document.querySelector<HTMLElement>(`.notice[data-id="${id}"]`)!;

  it('shrink, then expand when the Reload button appears', () => {
    notice('connection', 'Connection lost: reconnecting…', 'error', 'Reconnecting…');
    vi.advanceTimersByTime(COMPACT_AFTER_MS - 1);
    expect(noticeIsCompact('connection')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(noticeIsCompact('connection')).toBe(true);
    expect(el('connection').textContent).toBe('Reconnecting…');
    const reload = h('button', null, 'Reload');
    notice('connection', h('span', null, 'A new version is out: reload. ', reload), 'error');
    expect(noticeIsCompact('connection')).toBe(false);
    expect(el('connection').classList.contains('compact')).toBe(false);
    expect(el('connection').contains(reload)).toBe(true);
    vi.advanceTimersByTime(COMPACT_AFTER_MS * 2);
    expect(noticeIsCompact('connection')).toBe(false);
    notice('connection', null);
  });

  it('keep a countdown as a chip to the end', () => {
    notice('draining', 'Server update in 0:30', 'gold', 'Update 0:30');
    vi.advanceTimersByTime(COMPACT_AFTER_MS);
    notice('draining', 'Server update in 0:04', 'gold', 'Update 0:04');
    expect(noticeIsCompact('draining')).toBe(true);
    expect(el('draining').textContent).toBe('Update 0:04');
    expect(el('draining').classList.contains('gold')).toBe(true);
    notice('draining', null);
    expect(document.querySelector('.notice[data-id="draining"]')).toBeNull();
  });
});
