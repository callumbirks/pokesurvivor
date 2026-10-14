// Effect quality (Settings → quality): how many particles, sprites and damage numbers are drawn.
// `auto` starts high and steps down when the frame rate stays low (original implementation
// `sample`), and back up when it recovers.
import { settings } from '../../settings.js';

/** 0 low · 1 medium · 2 high. */
export type FxLevel = 0 | 1 | 2;

let autoLevel: FxLevel = 2;
let slow = 0;
let fast = 0;

export function fxLevel(): FxLevel {
  const q = settings.get().quality;
  return q === 'high' ? 2 : q === 'medium' ? 1 : q === 'low' ? 0 : autoLevel;
}

/** Feed every frame's real duration (seconds) while playing. */
export function sampleFrame(dt: number): void {
  if (settings.get().quality !== 'auto' || dt <= 0 || dt > 0.5) return;
  if (dt > 1 / 45) {
    slow += dt;
    fast = 0;
  } else {
    fast += dt;
    slow = Math.max(0, slow - dt * 0.25);
  }
  if (slow > 2 && autoLevel > 0) {
    autoLevel = (autoLevel - 1) as FxLevel;
    slow = 0;
  } else if (fast > 20 && autoLevel < 2) {
    autoLevel = (autoLevel + 1) as FxLevel;
    fast = 0;
  }
}
