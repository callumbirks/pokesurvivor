// In-game notices: short toasts (a teammate disconnected or came back, the owner changed, an
// achievement unlocked) and sticky notices that stay until cleared (reconnecting, server updating).
import { el, icon } from './dom.js';

export type ToastKind = 'info' | 'good' | 'warn' | 'achievement';

export class Toasts {
  readonly root: HTMLElement;
  private sticky = new Map<string, HTMLElement>();

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

  /** A notice that stays until `clear(key)` (or is replaced by the same key). */
  set(key: string, text: string, kind: ToastKind = 'warn'): void {
    // The same notice with new text (a countdown): changed in place, without its entry animation.
    const old = this.sticky.get(key);
    const span = old?.querySelector('span');
    if (old && span && old.classList.contains(kind)) {
      if (span.textContent !== text) span.textContent = text;
      return;
    }
    this.clear(key);
    const t = el(
      'div',
      { class: `ps-toast sticky ${kind}`, data: { key } },
      el('span', null, text),
    );
    this.root.prepend(t);
    this.sticky.set(key, t);
  }

  clear(key: string): void {
    this.sticky.get(key)?.remove();
    this.sticky.delete(key);
  }
}
