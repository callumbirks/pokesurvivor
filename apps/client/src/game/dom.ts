// A minimal element builder for the game's overlays (choices, pause, results, toasts).
import { iconImg } from '../icons.js';
import { type SpriteBox, animMeta, fitScale, initSprites, sheetUrl } from '../sprites.js';

type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  style?: string;
  title?: string;
  /** data-* attributes. */
  data?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (ev: Event) => void>>;
  disabled?: boolean;
  type?: string;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) {
    if (attrs.class) e.className = attrs.class;
    if (attrs.style) e.style.cssText = attrs.style;
    if (attrs.title) e.title = attrs.title;
    if (attrs.type) e.setAttribute('type', attrs.type);
    if (attrs.disabled) e.setAttribute('disabled', '');
    for (const [k, v] of Object.entries(attrs.data ?? {})) e.dataset[k] = v;
    for (const [k, fn] of Object.entries(attrs.on ?? {})) if (fn) e.addEventListener(k, fn);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(typeof c === 'number' ? String(c) : c);
  }
  return e;
}

export const icon = (name: string, size = 20): HTMLImageElement => iconImg(name, size);

export function clear(e: HTMLElement): void {
  while (e.firstChild) e.firstChild.remove();
}

/**
 * A Pokémon playing its idle animation (facing down), scaled without smoothing: the sheet as a CSS
 * background stepped through its frames (legacy ui.js `spriteCanvas(…, { lively })`). Fills in
 * once the sprite manifest is loaded.
 */
export function spriteEl(
  dex: number,
  opts: { shiny?: boolean; scale?: number; fit?: SpriteBox } = {},
): HTMLElement {
  const e = el('span', { class: 'ps-sprite', data: { dex: String(dex) } });
  const paint = () => {
    const anim = animMeta(dex, 'Idle', opts.shiny);
    const url = sheetUrl(dex, 'Idle', opts.shiny);
    if (!anim || !url) return;
    // Giants scale down to the box, standing on its bottom edge (feet on the baseline).
    const scale = fitScale(anim, opts.scale ?? 2, opts.fit);
    const w = anim.width * scale;
    const h = anim.height * scale;
    e.style.width = `${w}px`;
    e.style.height = `${h}px`;
    if (opts.fit) e.style.marginBottom = `${-(anim.height - anim.anchorY) * scale}px`;
    e.style.backgroundImage = `url("${url}")`;
    e.style.backgroundSize = `${w * anim.frames}px ${h * anim.rows}px`;
    e.style.setProperty('--sheet-w', `-${w * anim.frames}px`);
    e.style.setProperty('--frames', String(anim.frames));
    // Durations are in 1/60 s ticks (SpriteCollab AnimData).
    e.style.setProperty('--dur', `${anim.durations.reduce((a, b) => a + b, 0) / 60}s`);
  };
  void initSprites().then(paint);
  return e;
}
