// How big the in-run HUD is drawn. The world scales with the window (`Camera`: 768 world units
// across), but the HUD is laid out in CSS px at the original game's sizes, which suit windows up to
// about 1280 × 720 and look tiny on a large desktop. The automatic scale grows it with the window
// from there (1.5 at 1920 × 1080, 2 at 2560 × 1440) and never shrinks it, so phones (about
// 860 × 400 CSS px in landscape) look as before. The "HUD size" setting is Auto (that) or a fixed
// scale, 75–200%.

/** The window the HUD's layout was made for (CSS px). */
export const HUD_BASE_W = 1280;
export const HUD_BASE_H = 720;
export const HUD_MAX_AUTO = 2;
/** The "HUD size" setting's range when not on Auto (a scale: 1 = the original sizes). */
export const HUD_SIZE_MIN = 0.75;
export const HUD_SIZE_MAX = 2;

/** The automatic HUD scale for a game of this size (CSS px). */
export function autoHudScale(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return 1;
  const k = Math.min(w / HUD_BASE_W, h / HUD_BASE_H);
  return Math.min(HUD_MAX_AUTO, Math.max(1, k));
}

/**
 * The HUD scale to draw with: the automatic one, or the setting's fixed scale; rounded to 1/40 so
 * text and bars don't shimmer as a window is resized.
 */
export function hudScale(w: number, h: number, size: 'auto' | number): number {
  const k =
    size === 'auto'
      ? autoHudScale(w, h)
      : Math.min(HUD_SIZE_MAX, Math.max(HUD_SIZE_MIN, Number.isFinite(size) ? size : 1));
  return Math.round(k * 40) / 40;
}
