// The global toast and notice area: short messages (toasts) that fade on their own, and sticky
// notices (connection lost, server updating) that stay until cleared.
import { t } from '@pokesurvivor/data';
import { h, replace } from './dom.js';
import { audio } from '../audio.js';
import { ApiError } from './api.js';
import { calmClass, Shrink } from '../game/compact.js';
import type { UiStringKey } from '@pokesurvivor/data';

export type ToastKind = 'info' | 'good' | 'error' | 'gold';

let toastBox: HTMLElement | null = null;
let noticeBox: HTMLElement | null = null;

/** Creates the toast and notice containers (once). */
export function mountToasts(root: HTMLElement): void {
  toastBox = h('div', { class: 'toasts', 'aria-live': 'polite' });
  noticeBox = h('div', { class: 'notices', 'aria-live': 'polite' });
  root.append(noticeBox, toastBox);
  // Outside runs the notices are a banner at the top that the screens and the top bar make room
  // for (styles.css), so they never cover the menus: publish how tall it is.
  if (typeof ResizeObserver !== 'undefined') {
    const box = noticeBox;
    new ResizeObserver(() => {
      // In the stack's own (unzoomed) px, like the screens and the top bar that use it.
      const zoom = Number(getComputedStyle(box).zoom) || 1;
      const bottom = box.childElementCount ? box.getBoundingClientRect().bottom / zoom : 0;
      document.documentElement.style.setProperty('--notices-h', `${Math.ceil(bottom)}px`);
    }).observe(box);
  }
}

export function toast(text: string | Node, kind: ToastKind = 'info', ms = 3200): void {
  if (!toastBox) return;
  const el = h(
    'div',
    { class: ['toast', kind], role: kind === 'error' ? 'alert' : 'status' },
    text,
  );
  toastBox.append(el);
  while (toastBox.children.length > 4) toastBox.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

interface Notice {
  el: HTMLElement;
  full: string | Node;
  /** The chip it shrinks into (null: it stays in full, e.g. with a Reload button). */
  compact: string | Node | null;
  shrink: Shrink;
}
const notices = new Map<string, Notice>();

/**
 * Shows or replaces the sticky notice `id`; `null` removes it. With `compact` it shrinks into that
 * chip after `COMPACT_AFTER_MS` (a long countdown, reconnecting); replacing it without one (a
 * Reload button to press) brings it back in full.
 */
export function notice(
  id: string,
  content: string | Node | null,
  kind: ToastKind = 'info',
  compact?: string | Node,
): void {
  if (!noticeBox) return;
  let n = notices.get(id);
  if (content === null) {
    n?.shrink.stop();
    n?.el.remove();
    notices.delete(id);
    return;
  }
  if (!n) {
    const el = h('div', { class: ['notice', kind], dataset: { id } });
    calmClass(el);
    const shrink = new Shrink(() => renderNotice(entry));
    const entry: Notice = { el, full: content, compact: null, shrink };
    notices.set(id, entry);
    noticeBox.append(el);
    n = entry;
  }
  for (const k of ['info', 'good', 'error', 'gold'] as const) n.el.classList.toggle(k, k === kind);
  n.full = content;
  n.compact = compact ?? null;
  n.shrink.update(compact !== undefined);
  renderNotice(n);
}

function renderNotice(n: Notice): void {
  const compact = n.shrink.compact && n.compact !== null;
  n.el.classList.toggle('compact', compact);
  const content = compact ? n.compact! : n.full;
  // A live countdown re-renders four times a second: only touch the DOM when the text changes.
  if (typeof content === 'string' && n.el.childNodes.length === 1 && n.el.textContent === content)
    return;
  replace(n.el, content);
}

/** Is the sticky notice `id` a chip now (tests)? */
export function noticeIsCompact(id: string): boolean {
  return notices.get(id)?.shrink.compact ?? false;
}

/** The UI text for an API or room error code (`errors.<code>`), falling back to a generic one. */
export function errorText(err: unknown): string {
  const code =
    err instanceof ApiError
      ? err.code
      : typeof err === 'object' && err !== null && 'code' in err
        ? String(err.code)
        : 'unknown';
  const key = `errors.${code}` as UiStringKey;
  const text = t(key);
  return text === key ? t('errors.unknown', { 0: code }) : text;
}

export function toastError(err: unknown): void {
  audio.sfx('error');
  toast(errorText(err), 'error', 4500);
}
