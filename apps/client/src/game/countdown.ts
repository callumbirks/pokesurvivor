// Countdowns to a server time (already in `Date.now()` time): a server update, a restored game
// waiting for its players. And the 3-2-1 after a rift, which the sim counts (`misc.resume`).
import { t } from '@pokesurvivor/data';
import type { Toasts } from './toasts.js';

/** `m:ss` left until `deadline` (rounded up, so it reads 0:00 only once it's due). */
export function clockText(deadline: number, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Whole seconds left until `deadline` (rounded up, never below 0). */
export function secondsLeft(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * Calls `render` now and four times a second while `deadline` is in the future (and once when
 * it's due). Returns a function that stops it.
 */
export function everyTick(deadline: number, render: (now: number) => void): () => void {
  render(Date.now());
  const timer = setInterval(() => {
    const now = Date.now();
    render(now);
    if (now >= deadline) clearInterval(timer);
  }, 250);
  return () => clearInterval(timer);
}

/**
 * Back from a rift, the map waits for a 3-2-1: shown like a restored game's "Resuming in 3…",
 * from the newest snapshot's `misc.resume` (whole seconds; absent once the map moves again).
 */
export function riftResume(toasts: Pick<Toasts, 'set' | 'clear'>, resume?: number): void {
  if (resume && resume > 0)
    toasts.set('rift-resume', t('game.noticeResuming', { 0: String(resume) }), 'info');
  else toasts.clear('rift-resume');
}
