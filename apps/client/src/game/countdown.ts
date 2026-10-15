// Countdowns to a server time (already in `Date.now()` time): a server update, a restored game
// waiting for its players.

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
