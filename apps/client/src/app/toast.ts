// The global toast and notice area: short messages (toasts) that fade on their own, and sticky
// notices (connection lost, server updating) that stay until cleared.
import { t } from '@pokesurvivor/data';
import { h, replace } from './dom.js';
import { ApiError } from './api.js';
import type { UiStringKey } from '@pokesurvivor/data';

export type ToastKind = 'info' | 'good' | 'error' | 'gold';

let toastBox: HTMLElement | null = null;
let noticeBox: HTMLElement | null = null;
const notices = new Map<string, HTMLElement>();

/** Creates the toast and notice containers (once). */
export function mountToasts(root: HTMLElement): void {
  toastBox = h('div', { class: 'toasts', 'aria-live': 'polite' });
  noticeBox = h('div', { class: 'notices', 'aria-live': 'polite' });
  root.append(noticeBox, toastBox);
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

/** Shows or replaces the sticky notice `id`; `null` removes it. */
export function notice(id: string, content: string | Node | null, kind: ToastKind = 'info'): void {
  if (!noticeBox) return;
  const old = notices.get(id);
  if (content === null) {
    old?.remove();
    notices.delete(id);
    return;
  }
  if (old) {
    old.className = `notice ${kind}`;
    replace(old, content);
    return;
  }
  const el = h('div', { class: ['notice', kind], dataset: { id } }, content);
  notices.set(id, el);
  noticeBox.append(el);
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
  toast(errorText(err), 'error', 4500);
}
