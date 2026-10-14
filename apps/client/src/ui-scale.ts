// How big the DOM menus and the in-run overlays are drawn. They're laid out in CSS px for a window
// of about 1280 × 720 and look tiny on a large display, so they grow with the window from there,
// as the HUD does (`game/hudscale.ts`): ×1.5 at 1920 × 1080, ×2 at 2560 × 1440 and up, never
// smaller, so phones look as before. Half steps keep the pixel art and the 9-slice frames even.
// Automatic only (the HUD size setting is the HUD's).
//   uiScale(w, h)       the scale for a window (CSS px)
//   installUiScale()    keeps `--ui-scale` on <html> up to date (the stylesheet zooms with it)

/** The window the menus were laid out for (CSS px). */
export const UI_BASE_W = 1280;
export const UI_BASE_H = 720;
export const UI_MAX_SCALE = 2;
/** The scale's steps. */
export const UI_SCALE_STEP = 0.5;

/** The menus' scale for a window of this size (CSS px): 1 to `UI_MAX_SCALE`, in half steps. */
export function uiScale(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return 1;
  const k = Math.min(w / UI_BASE_W, h / UI_BASE_H, UI_MAX_SCALE);
  return Math.max(1, Math.floor(k / UI_SCALE_STEP) * UI_SCALE_STEP);
}

let installed = false;

/** Sets `--ui-scale` on <html> now and on every resize. Idempotent. */
export function installUiScale(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const update = () =>
    document.documentElement.style.setProperty(
      '--ui-scale',
      String(uiScale(window.innerWidth, window.innerHeight)),
    );
  update();
  addEventListener('resize', update);
}
