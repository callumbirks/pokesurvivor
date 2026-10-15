// A modal confirm window for the menus: a title, any content, and Cancel / confirm buttons. Esc, B
// or a click outside cancel; the gamepad navigates inside it while it's open.
import { menuNav } from '../menu-nav.js';
import { h } from './dom.js';

type Child = Parameters<typeof h>[2];

export interface ConfirmOptions {
  title: string;
  body: Child[];
  confirmLabel: string;
  cancelLabel: string;
  testid?: string;
}

/** Shows the dialog over the page; resolves true for confirm, false otherwise. */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = h(
      'button',
      { class: 'btn', type: 'button', dataset: { testid: 'dialog-cancel', back: '' } },
      o.cancelLabel,
    );
    const ok = h(
      'button',
      {
        class: 'btn primary',
        type: 'button',
        dataset: { testid: 'dialog-confirm', navDefault: '' },
      },
      o.confirmLabel,
    );
    const box = h(
      'div',
      {
        class: 'box dialog-box',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': o.title,
        dataset: { testid: o.testid ?? 'dialog' },
      },
      h('h3', null, o.title),
      ...o.body,
      h('div', { class: 'dialog-btns' }, cancel, ok),
    );
    const overlay = h('div', { class: 'dialog-overlay' }, box);
    let popNav = () => {};
    const close = (result: boolean) => {
      popNav();
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(false);
    };
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    popNav = menuNav.push({ root: overlay, back: () => close(false) });
    ok.focus();
  });
}
