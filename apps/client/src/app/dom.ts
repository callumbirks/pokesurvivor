// Tiny DOM helpers for the menu screens: an element builder and a few shared widgets (Pokémon
// sprites, rarity stars, type chips). No framework: screens build their DOM with `h()` and
// rebuild the parts that change.
import { loadGameData, t, type UiStringKey } from '@pokesurvivor/data';
import type { SpriteData } from '@pokesurvivor/data/sprites';
import { iconImg, iconUrl } from '../icons.js';

type Child = Node | string | number | null | undefined | false | readonly Child[];

type Attrs = {
  class?: string | (string | false | null | undefined)[];
  style?: string | Partial<Record<string, string>>;
  dataset?: Record<string, string>;
  /** Event listeners: `on: { click: fn }`. */
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
} & Record<string, unknown>;

/** Builds an element: `h('button', { class: 'btn', on: { click } }, 'Go')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') {
        el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : (value as string);
      } else if (key === 'style') {
        if (typeof value === 'string') el.style.cssText = value;
        else
          for (const [p, v] of Object.entries(value as Record<string, string>))
            el.style.setProperty(p, v);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key === 'on') {
        for (const [ev, fn] of Object.entries(value as Record<string, EventListener>))
          el.addEventListener(ev, fn);
      } else if (value === true) {
        el.setAttribute(key, '');
      } else if (typeof value === 'string' || typeof value === 'number') {
        el.setAttribute(key, String(value));
      } else {
        // Non-string values are DOM properties (e.g. `disabled`, `value` as a number).
        (el as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c as readonly Child[]);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c as string)));
  }
}

/** Replaces the children of `el`. */
export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

// ---------------------------------------------------------------- game-data widgets

export const gameData = () => loadGameData();

export function pokemonName(dex: number): string {
  return gameData().pokemonByDex.get(dex)?.name ?? `#${dex}`;
}

export function rarityInfo(rarity: number): { name: string; color: string } {
  const r = gameData().gacha.rarities.find((x) => x.rarity === rarity);
  return { name: r?.name ?? String(rarity), color: r?.color ?? '#fff' };
}

/**
 * A UI string with nodes (icons) in its placeholders: `{ticket}` → an `<img>`. Text params are
 * filled in as by `t()`.
 */
export function tNodes(key: UiStringKey, params: Record<string, string | number | Node>): Node[] {
  const text = t(key);
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    const value = params[m[1] ?? ''];
    if (value === undefined) continue;
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    out.push(value instanceof Node ? value : document.createTextNode(String(value)));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** Rarity as a Poké Ball, as legacy did: Poké, Great, Ultra, Luxury and Master Ball. */
export const RARITY_BALL: Readonly<Record<number, string>> = {
  1: 'ball',
  2: 'ball2',
  3: 'ball3',
  4: 'ballLux',
  5: 'ball4',
};

/** A pixel-art icon (`src/icons.ts`) as an `<img>`, snapped to a whole multiple of its pixels. */
export function icon(name: string, size = 20, cls?: string): HTMLImageElement {
  const img = iconImg(name, size);
  if (cls) img.classList.add(cls);
  return img;
}

/** The rarity's Poké Ball, titled with the rarity's name. */
export function rarityBall(rarity: number, size = 12): HTMLElement {
  return h(
    'span',
    { class: 'rarity-ball', title: rarityInfo(rarity).name },
    icon(RARITY_BALL[rarity] ?? 'ball', size),
  );
}

/** Publishes the icons the stylesheet uses (`--ico-cursor`, `--ico-coin`) as CSS variables. */
export function installIconCss(): void {
  const root = document.documentElement.style;
  for (const name of ['cursor', 'coin', 'ticket', 'ticket10', 'shiny', 'gear'])
    root.setProperty(`--ico-${name}`, `url("${iconUrl(name)}")`);
}

export function typeColor(type: string): string {
  return gameData().types.types.find((t) => t.id === type)?.color ?? '#9fb1c9';
}

export function typeChip(type: string): HTMLElement {
  const t = gameData().types.types.find((x) => x.id === type);
  return h(
    'span',
    { class: 'type', style: { background: t?.color ?? '#9fb1c9' } },
    t?.name ?? type,
  );
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function num(n: number): string {
  return n.toLocaleString('en');
}

// ---------------------------------------------------------------- sprites

let sprites: SpriteData | null = null;
let spritesLoading: Promise<SpriteData> | null = null;

/** Loads the sprite manifest (large: its own chunk). Sprites drawn before it loads fill in. */
export function loadSprites(): Promise<SpriteData> {
  spritesLoading ??= import('@pokesurvivor/data/sprites').then((m) => {
    sprites = m.loadSpriteManifest();
    for (const el of document.querySelectorAll<HTMLElement>('.sprite[data-pending]')) paint(el);
    return sprites;
  });
  return spritesLoading;
}

export interface SpriteOptions {
  shiny?: boolean;
  /** Pixel scale (sprites are small pixel art). */
  scale?: number;
  /** Black shape only: not owned yet. */
  silhouette?: boolean;
  /** Plays the idle animation. */
  lively?: boolean;
}

/**
 * A Pokémon's idle sprite (first frame of the sheet, facing down) as a CSS background, scaled
 * without smoothing. Animated with CSS steps when `lively`.
 */
export function sprite(dex: number, opts: SpriteOptions = {}): HTMLElement {
  const el = h('span', {
    class: ['sprite', opts.silhouette && 'silhouette', opts.lively && 'lively'],
    dataset: {
      dex: String(dex),
      scale: String(opts.scale ?? 2),
      shiny: opts.shiny ? '1' : '',
    },
    role: 'img',
    'aria-label': opts.silhouette ? '???' : pokemonName(dex),
  });
  if (sprites) paint(el);
  else {
    el.dataset.pending = '1';
    void loadSprites();
  }
  return el;
}

function paint(el: HTMLElement): void {
  delete el.dataset.pending;
  const entry = sprites?.byDex.get(Number(el.dataset.dex));
  if (!sprites || !entry) {
    el.classList.add('missing');
    return;
  }
  const anim = entry.animations.Idle;
  const scale = Number(el.dataset.scale) || 2;
  const url = `${sprites.basePath}/${entry.dex}/${el.dataset.shiny && entry.shiny ? 's/' : ''}Idle.png?v=${entry.hash}`;
  const w = anim.width * scale;
  const ht = anim.height * scale;
  el.style.width = `${w}px`;
  el.style.height = `${ht}px`;
  el.style.backgroundImage = `url("${url}")`;
  el.style.backgroundSize = `${w * anim.frames}px ${ht * anim.rows}px`;
  el.style.setProperty('--sheet-w', `-${w * anim.frames}px`);
  el.style.setProperty('--frames', String(anim.frames));
  // Durations are in 1/60 s ticks (SpriteCollab AnimData).
  el.style.setProperty('--dur', `${anim.durations.reduce((a, b) => a + b, 0) / 60}s`);
}
