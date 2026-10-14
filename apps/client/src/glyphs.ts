// Controller button glyphs (Kenney's "Input Prompts Pixel", CC0: see CREDITS.md), in the DOM and
// on the HUD canvas, for an Xbox or a PlayStation layout (`inputDevice.layout`).
//   glyph('a')                     a <span> showing the button; the stylesheet picks the layout
//   inputHint(keys, buttons)       keys (<kbd>) with the keyboard and mouse, glyphs with a gamepad
//   drawGlyph(ctx, 'r3', x, y, 16) on a canvas, in the current layout
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

/** A button's glyph (`size`: CSS px, best a multiple of 16). */
export function glyph(button: PadButton, size = 16): HTMLElement {
  const e = document.createElement('span');
  e.className = 'glyph';
  e.dataset.glyph = button;
  if (size !== TILE_PX) e.style.setProperty('--gs', `${size}px`);
  return e;
}

/**
 * An input prompt: `keys` while the keyboard and mouse (or touch) are in use, the gamepad's
 * `buttons` while it is.
 */
export function inputHint(
  keys: readonly (Node | string)[],
  buttons: readonly PadButton[],
  size = 16,
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

/** A UI string with glyph placeholders, as text and glyphs. */
export function glyphText(text: string, size = 16): Node[] {
  return splitGlyphs(text).map((p) =>
    typeof p === 'string' ? document.createTextNode(p) : glyph(p.button, size),
  );
}

let atlas: HTMLImageElement | null = null;

/** Draws a button's glyph at (x, y) (top left), `size` px square, in the current layout. */
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
  const smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(atlas, i * TILE_PX, 0, TILE_PX, TILE_PX, x, y, size, size);
  ctx.imageSmoothingEnabled = smooth;
}

/**
 * A line of text with glyphs in it, centred on `cx` at baseline `y` (the font and colour set):
 * `{a}`, `{lstick}` … in `text` become glyphs `size` px tall.
 */
export function drawGlyphText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  size: number,
  layout: PadLayout = inputDevice.layout,
): void {
  const parts = splitGlyphs(text);
  const widths = parts.map((p) => (typeof p === 'string' ? ctx.measureText(p).width : size));
  let x = cx - widths.reduce((a, b) => a + b, 0) / 2;
  const align = ctx.textAlign;
  ctx.textAlign = 'left';
  parts.forEach((p, i) => {
    if (typeof p === 'string') ctx.fillText(p, x, y);
    else drawGlyph(ctx, p.button, Math.round(x), Math.round(y - size * 0.8), size, layout);
    x += widths[i] ?? 0;
  });
  ctx.textAlign = align;
}
