// Sticky notices that would sit over the game for long (a server update's countdown, connection
// lost, a restored game waiting for its players) pop up in full, then shrink into a small chip
// with the same live text in short. They expand again only for something the player must act on
// (a Reload button), which the caller shows without a compact form.
import { settings } from '../settings.js';

/** How long a notice stays big before it shrinks into a chip. */
export const COMPACT_AFTER_MS = 3000;

/** Calm mode (or the OS asking for less motion, in CSS): the shrink isn't animated. */
export function calmClass(el: HTMLElement): void {
  if (settings.get().calmMode) el.classList.add('calm');
}

/**
 * One notice's big → chip state. `update(compact)` on every change: a compact form starts the
 * timer (once); none expands it for good (until a later compact form starts it again).
 */
export class Shrink {
  compact = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onShrink: () => void) {}

  update(compactable: boolean): void {
    if (!compactable) {
      this.stop();
      this.compact = false;
      return;
    }
    if (this.compact || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.compact = true;
      this.onShrink();
    }, COMPACT_AFTER_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
