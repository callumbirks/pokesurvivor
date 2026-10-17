// In-game notices: short toasts (a teammate disconnected or came back, the owner changed, an
// achievement unlocked) and sticky notices that stay until cleared (reconnecting, server updating).
import { calmClass, Shrink } from './compact.js';
import { el, icon } from './dom.js';

export type ToastKind = 'info' | 'good' | 'warn' | 'achievement';

interface Sticky {
  el: HTMLElement;
  /** The full text, and the chip's (null: it never shrinks). */
  text: string;
  compact: string | null;
  shrink: Shrink;
}

export class Toasts {
  readonly root: HTMLElement;
  private sticky = new Map<string, Sticky>();

  constructor(parent: HTMLElement) {
    this.root = el('div', { class: 'ps-toasts', data: { testid: 'toasts' } });
    parent.append(this.root);
  }

  show(text: string, kind: ToastKind = 'info', seconds = 3.5, iconName?: string): void {
    const t = el(
      'div',
      { class: `ps-toast ${kind}` },
      iconName ? icon(iconName, 18) : null,
      el('span', null, text),
    );
    this.root.append(t);
    // Six at most: the oldest go first.
    while (this.root.children.length > 6) this.root.firstElementChild?.remove();
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 400);
    }, seconds * 1000);
  }

  /**
   * A notice that stays until `clear(key)` (or is replaced by the same key with another kind).
   * With `compact`, it shrinks into that short chip after `COMPACT_AFTER_MS`; calling it again
   * without one expands it (a notice the player has to act on).
   */
  set(key: string, text: string, kind: ToastKind = 'warn', compact?: string): void {
    let s = this.sticky.get(key);
    if (s && !s.el.classList.contains(kind)) {
      this.clear(key);
      s = undefined;
    }
    if (!s) {
      const node = el('div', { class: `ps-toast sticky ${kind}`, data: { key } }, el('span', null));
      calmClass(node);
      const shrink = new Shrink(() => this.render(entry));
      const entry: Sticky = { el: node, text, compact: compact ?? null, shrink };
      this.root.prepend(node);
      this.sticky.set(key, entry);
      s = entry;
    }
    s.text = text;
    s.compact = compact ?? null;
    s.shrink.update(compact !== undefined);
    this.render(s);
  }

  /** Is the notice `key` a chip now (tests, layout)? */
  isCompact(key: string): boolean {
    return this.sticky.get(key)?.shrink.compact ?? false;
  }

  private render(s: Sticky): void {
    const compact = s.shrink.compact && s.compact !== null;
    s.el.classList.toggle('compact', compact);
    const span = s.el.querySelector('span')!;
    const text = compact ? s.compact! : s.text;
    if (span.textContent !== text) span.textContent = text;
  }

  clear(key: string): void {
    const s = this.sticky.get(key);
    s?.shrink.stop();
    s?.el.remove();
    this.sticky.delete(key);
  }
}
