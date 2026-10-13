// A minimal element builder for the game's overlays (choices, pause, results, toasts).
import { iconImg } from '../icons.js';

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
