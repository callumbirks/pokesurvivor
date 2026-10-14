// Controller button glyphs (Kenney's "Input Prompts Pixel", CC0: see CREDITS.md), in the DOM and
// on the HUD canvas, for an Xbox or a PlayStation layout (`inputDevice.layout`).
//   glyph('a')                     a <span> showing the button; the stylesheet picks the layout
//   inputHint(keys, buttons)       keys (<kbd>) with the keyboard and mouse, glyphs with a gamepad
//   drawGlyph(ctx, 'r3', x, y, 16) on a canvas, in the current layout (drawGlyphText: a line)
// `public/glyphs/gamepad.png` is one row of 16 × 16 tiles in `TILE` order.
import './glyphs.css';
import { inputDevice, type PadLayout } from './input-device.js';

export type PadButton =
  | 'a'
  | 'b'
  | 'x'
  | 'y'
  | 'start'
  | 'select'
  | 'lb'
  | 'rb'
  | 'rt'
  | 'r3'
  | 'dpad'
  | 'dpadH'
  | 'dpadV'
  | 'lstick'
  | 'rstick';

/** Each button's tile in the atlas, per layout. Keep in sync with `glyphs.css`. */
export const TILE: Record<PadLayout, Record<PadButton, number>> = {
  xbox: {
    a: 0,
    b: 1,
    x: 2,
    y: 3,
    start: 4,
    lb: 5,
    rb: 6,
    rt: 7,
    r3: 8,
    dpad: 18,
    dpadH: 19,
    dpadV: 20,
    lstick: 21,
    rstick: 24,
    select: 22,
  },
  playstation: {
    a: 9,
    b: 10,
    x: 11,
    y: 12,
    start: 13,
    lb: 14,
    rb: 15,
    rt: 16,
    r3: 17,
    dpad: 18,
    dpadH: 19,
    dpadV: 20,
    lstick: 21,
    rstick: 24,
    select: 23,
  },
};

export const GLYPH_URL = `${import.meta.env.BASE_URL}glyphs/gamepad.png`;
const TILE_PX = 16;

/** The DOM glyphs' size (CSS px): the 16 px tiles at 2×, to read next to the menus' text. */
export const GLYPH_PX = TILE_PX * 2;

/** A button's glyph (`size`: CSS px, a multiple of 16 to stay crisp). */
export function glyph(button: PadButton, size = GLYPH_PX): HTMLElement {
  const e = document.createElement('span');
  e.className = 'glyph';
  e.dataset.glyph = button;
  if (size !== GLYPH_PX) e.style.setProperty('--gs', `${size}px`);
  return e;
}

/**
 * An input prompt: `keys` while the keyboard and mouse (or touch) are in use, the gamepad's
 * `buttons` while it is.
 */
export function inputHint(
  keys: readonly (Node | string)[],
  buttons: readonly PadButton[],
  size = GLYPH_PX,
): HTMLElement {
  const kb = document.createElement('span');
  kb.className = 'kb-only';
  kb.append(...keys.map((k) => (typeof k === 'string' ? kbd(k) : k)));
  const pad = document.createElement('span');
  pad.className = 'pad-only glyphs';
  pad.append(...buttons.map((b) => glyph(b, size)));
  const e = document.createElement('span');
  e.className = 'input-hint';
  e.append(kb, pad);
  return e;
}

export function kbd(text: string): HTMLElement {
  const e = document.createElement('kbd');
  e.textContent = text;
  return e;
}

/** Splits a UI string with `{a}`, `{lstick}` … placeholders into text and buttons. */
export function splitGlyphs(text: string): (string | { button: PadButton })[] {
  return text
    .split(/(\{\w+\})/)
    .filter(Boolean)
    .map((p) => {
      const name = /^\{(\w+)\}$/.exec(p)?.[1];
      return name && name in TILE.xbox ? { button: name as PadButton } : p;
    });
}

/** The separator between the controls in a hint line ("{a} jump · {b} back"). */
const HINT_SEPARATOR = ' · ';

/**
 * A UI string with glyph placeholders, as text and glyphs. Each control between ` · `
 * separators stays on one line (`.glyph-group`), so a long line wraps between controls, never
 * between a glyph and what it does.
 */
export function glyphText(text: string, size = GLYPH_PX): Node[] {
  const out: Node[] = [];
  text.split(HINT_SEPARATOR).forEach((part, i) => {
    if (i) out.push(document.createTextNode(HINT_SEPARATOR));
    const group = document.createElement('span');
    group.className = 'glyph-group';
    group.append(
      ...splitGlyphs(part).map((p) =>
        typeof p === 'string' ? document.createTextNode(p) : glyph(p.button, size),
      ),
    );
    out.push(group);
  });
  return out;
}

let atlas: HTMLImageElement | null = null;

/**
 * The size a glyph asked for at `size` is drawn at under the canvas's transform (drawing units):
 * the whole multiple of its 16 px tile nearest to `size` on screen.
 */
export function glyphDrawSize(ctx: CanvasRenderingContext2D, size: number): number {
  const m = ctx.getTransform();
  const k = Math.hypot(m.a, m.b) || 1;
  return (Math.max(1, Math.round((size * k) / TILE_PX)) * TILE_PX) / k;
}

/**
 * Draws a button's glyph in the `size` px square at (x, y) (top left), in the current layout.
 * It's snapped to whole device pixels under the canvas's transform (the HUD is scaled), at
 * `glyphDrawSize`, centred in the square.
 */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  button: PadButton,
  x: number,
  y: number,
  size: number,
  layout: PadLayout = inputDevice.layout,
): void {
  if (!atlas) {
    atlas = new Image();
    atlas.src = GLYPH_URL;
  }
  if (!atlas.complete || !atlas.naturalWidth) return;
  const i = TILE[layout][button];
  const m = ctx.getTransform();
  const k = Math.hypot(m.a, m.b) || 1;
  const s2 = glyphDrawSize(ctx, size);
  const at = (v: number, offset: number) =>
    (Math.round((v + (size - s2) / 2) * k + offset) - offset) / k;
  const smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(atlas, i * TILE_PX, 0, TILE_PX, TILE_PX, at(x, m.e), at(y, m.f), s2, s2);
  ctx.imageSmoothingEnabled = smooth;
}

/** Space (drawing units) between two glyphs side by side, and between a glyph and text. */
export const GLYPH_GAP = 4;
export const GLYPH_TEXT_GAP = 3;

/**
 * A line of text with glyphs in it, centred on `cx`, its glyphs' middle at `cy` (the font and
 * colour set): `{a}`, `{lstick}` … in `text` become glyphs about `size` px tall (`glyphDrawSize`),
 * with `GLYPH_GAP` between glyphs and `GLYPH_TEXT_GAP` next to text. If it's wider than
 * `maxWidth`, the glyphs step down a tile multiple at a time until it fits (or are one tile).
 * Returns the glyphs' drawn size.
 */
export function drawGlyphText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  size: number,
  opts: { layout?: PadLayout; maxWidth?: number } = {},
): number {
  const parts = splitGlyphs(text);
  const textW = parts.map((p) => (typeof p === 'string' ? ctx.measureText(p).width : 0));
  const glyphs = parts.filter((p) => typeof p !== 'string').length;
  let gap = 0;
  parts.forEach((p, i) => {
    const prev = parts[i - 1];
    if (!prev || (typeof p === 'string' && typeof prev === 'string')) return;
    gap += typeof p !== 'string' && typeof prev !== 'string' ? GLYPH_GAP : GLYPH_TEXT_GAP;
  });
  const fixed = textW.reduce((a, b) => a + b, 0) + gap;
  let gs = glyphDrawSize(ctx, size);
  const min = glyphDrawSize(ctx, 1);
  while (opts.maxWidth && gs > min && fixed + glyphs * gs > opts.maxWidth)
    gs = glyphDrawSize(ctx, gs - min);
  let x = cx - (fixed + glyphs * gs) / 2;
  // The text's capitals centred on the glyphs.
  const cap = ctx.measureText('H').actualBoundingBoxAscent || gs * 0.6;
  const align = ctx.textAlign;
  ctx.textAlign = 'left';
  parts.forEach((p, i) => {
    const prev = parts[i - 1];
    if (prev && !(typeof p === 'string' && typeof prev === 'string'))
      x += typeof p !== 'string' && typeof prev !== 'string' ? GLYPH_GAP : GLYPH_TEXT_GAP;
    if (typeof p === 'string') {
      ctx.fillText(p, x, cy + cap / 2);
      x += textW[i] ?? 0;
    } else {
      drawGlyph(ctx, p.button, x, cy - gs / 2, gs, opts.layout);
      x += gs;
    }
  });
  ctx.textAlign = align;
  return gs;
}
