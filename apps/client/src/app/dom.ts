// Tiny DOM helpers for the menu screens: an element builder and a few shared widgets (Pokémon
// sprites, rarity stars, type chips). No framework: screens build their DOM with `h()` and
// rebuild the parts that change.
import { loadGameData, t, type UiStringKey } from '@pokesurvivor/data';
import type { SpriteData } from '@pokesurvivor/data/sprites';
import { iconImg, iconUrl } from '../icons.js';
import { fitScale, shadowRadii, spriteLayout, type SpriteBox } from '../sprites.js';

export { fitScale, type SpriteBox };

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
  /** Pixel scale (sprites are small pixel art): the same for every Pokémon in a view. */
  scale?: number;
  /**
   * The box it must fit in (CSS px): a smaller scale for the giants (Eternatus, Rayquaza…), from
   * the sprite's real frame (`fitScale`). Without it, the sprite is drawn at `scale` whatever
   * its size.
   */
  fit?: SpriteBox;
  /**
   * Stands on the container's bottom edge: the frame's space below the feet hangs under it, so
   * a row of Pokémon shares one baseline whatever their frame sizes (legacy's feet anchor).
   */
  feet?: boolean;
  /** Black shape only: not owned yet. */
  silhouette?: boolean;
  /** Plays the idle animation. */
  lively?: boolean;
}

/** A shared fit box for the screen size: `wide` on desktop, `narrow` on phones. */
export function boxFor(wide: SpriteBox, narrow: SpriteBox): SpriteBox {
  const small =
    typeof matchMedia === 'function' &&
    matchMedia('(max-width: 760px), (max-height: 520px)').matches;
  return small ? narrow : wide;
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
      fit: opts.fit ? `${opts.fit.width}x${opts.fit.height}` : '',
      feet: opts.feet ? '1' : '',
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
  const [fw, fh] = (el.dataset.fit ?? '').split('x').map(Number);
  const feet = !!el.dataset.feet;
  // Standing sprites get the game's ground shadow (not silhouettes, as in legacy).
  const shadowSize = feet && !el.classList.contains('silhouette') ? entry.shadowSize : null;
  const lay = spriteLayout(anim, {
    scale: Number(el.dataset.scale) || 2,
    box: fw && fh ? { width: fw, height: fh } : undefined,
    shadowSize,
    feet,
  });
  const k = lay.scale;
  const url = `${sprites.basePath}/${entry.dex}/${el.dataset.shiny && entry.shiny ? 's/' : ''}Idle.png?v=${entry.hash}`;
  el.style.width = `${lay.width}px`;
  el.style.height = `${lay.height}px`;
  // The lowest visible pixel (art or shadow) on the container's content edge.
  if (feet) el.style.marginBottom = `${lay.marginBottom}px`;
  const sheet = `${lay.width * anim.frames}px ${lay.height * anim.rows}px`;
  if (shadowSize !== null) {
    // The shadow is a second layer under the sheet, fixed while the frames step.
    const { rx, ry } = shadowRadii(shadowSize);
    el.style.backgroundImage = `url("${url}"), radial-gradient(ellipse ${rx * k}px ${ry * k}px at ${anim.anchorX * k}px ${anim.anchorY * k}px, rgba(0, 0, 0, 0.34) 96%, transparent 100%)`;
    el.style.backgroundSize = `${sheet}, 100% 100%`;
  } else {
    el.style.backgroundImage = `url("${url}")`;
    el.style.backgroundSize = sheet;
  }
  el.style.setProperty('--sheet-w', `-${lay.width * anim.frames}px`);
  el.style.setProperty('--frames', String(anim.frames));
  // Durations are in 1/60 s ticks (SpriteCollab AnimData).
  el.style.setProperty('--dur', `${anim.durations.reduce((a, b) => a + b, 0) / 60}s`);
}

// ---------------------------------------------------------------- cursor lists

/**
 * A cursor list (`.cursor-list` of `.cursor-item` buttons): one item is selected, drawn as a
 * light bar with the pixel cursor. Pointing at an item focuses and selects it, and the keyboard
 * or gamepad focus selects what it lands on, so the mouse, keys and pad share one selection.
 * Items are told apart by `data-testid`, so the selection survives re-rendering the items.
 */
export class CursorList {
  private key: string | null = null;

  /**
   * `onSelect` hears each new selection. `navDefault`: the gamepad's first press lands on the
   * selected item (`data-nav-default`).
   */
  constructor(
    readonly el: HTMLElement,
    private readonly opts: { onSelect?: (item: HTMLElement) => void; navDefault?: boolean } = {},
  ) {
    el.classList.add('cursor-list');
    el.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse') return;
      const item = this.itemAt(e.target);
      if (!item || item === this.selected) return;
      item.focus({ preventScroll: true });
      this.select(item);
    });
    el.addEventListener('focusin', (e) => {
      const item = this.itemAt(e.target);
      if (item) this.select(item);
    });
  }

  get selected(): HTMLElement | null {
    return this.items().find((i) => i.classList.contains('on')) ?? null;
  }

  /** Selects `item` (null: none). */
  select(item: HTMLElement | null): void {
    for (const i of this.items()) {
      const on = i === item;
      i.classList.toggle('on', on);
      if (this.opts.navDefault) i.toggleAttribute('data-nav-default', on);
    }
    const key = item?.dataset.testid ?? null;
    const changed = key !== this.key;
    this.key = key;
    if (item && changed) this.opts.onSelect?.(item);
  }

  /**
   * After the items were rebuilt: selects the same item as before if it is still enabled, else
   * `fallback`, and tells `onSelect` again (its text may have changed with the items).
   */
  refresh(fallback: HTMLElement | null = null): void {
    const same = this.items().find((i) => i.dataset.testid === this.key && !this.disabled(i));
    this.key = null;
    this.select(same ?? fallback);
  }

  private items(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>('.cursor-item')];
  }

  private disabled(item: HTMLElement): boolean {
    return item.matches(':disabled');
  }

  private itemAt(target: EventTarget | null): HTMLElement | null {
    const item = target instanceof Element ? target.closest<HTMLElement>('.cursor-item') : null;
    return item && this.el.contains(item) && !this.disabled(item) ? item : null;
  }
}
