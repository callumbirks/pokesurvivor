// Countdowns to a server time (already in `Date.now()` time): a server update, a restored game
// waiting for its players. And the 3-2-1 after a rift, which the sim counts (`misc.resume`).
import { t } from '@pokesurvivor/data';
import { el } from './dom.js';

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
 * The "Resuming in 3…" over the game: a restored game about to go on, or the team back from a rift
 * (the sim counts that one; `misc.resume`). `show(0)` takes it away.
 */
export class ResumeCountdown {
  private node: HTMLElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  show(seconds: number): void {
    if (seconds <= 0) return this.hide();
    this.node ??= el('div', { class: 'ps-resume', data: { testid: 'resume-countdown' } });
    if (!this.node.isConnected) this.parent.append(this.node);
    const text = t('game.noticeResuming', { 0: String(seconds) });
    if (this.node.textContent !== text) this.node.textContent = text;
  }

  hide(): void {
    this.node?.remove();
    this.node = null;
  }
}
