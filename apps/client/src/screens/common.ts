// Building blocks shared by the menu screens: the window with a title and a back button, the
// input prompts along the bottom, and the loading / error states for screens that fetch data.
import { t } from '@pokesurvivor/data';
import type { App } from '../app/app.js';
import { h, replace } from '../app/dom.js';
import { errorText } from '../app/toast.js';
import { inputHint, type PadButton } from '../glyphs.js';

export interface ScreenBox {
  /** The screen's root (`.scr`). */
  el: HTMLElement;
  /** The box below the header. */
  body: HTMLElement;
  header: HTMLElement;
}

/**
 * A full-screen layer with a box, a title and (by default) a back button to the menu (`back`: to
 * that route instead, null: none; `onBack`: calls it instead of navigating).
 */
export function screenBox(
  app: App,
  opts: {
    id: string;
    title: string | Node;
    wide?: boolean;
    back?: string | null;
    onBack?: () => void;
    extra?: Node[];
  },
): ScreenBox {
  const back =
    opts.back === null
      ? null
      : backButton(app, () => (opts.onBack ? opts.onBack() : app.go(opts.back ?? 'menu')));
  const header = h(
    'div',
    { class: 'row between box-head' },
    h('h2', null, opts.title),
    h('div', { class: 'row' }, ...(opts.extra ?? []), back),
  );
  const body = h('div', { class: 'box-body' });
  const el = h(
    'section',
    { class: ['scr', 'dim', `scr-${opts.id}`], dataset: { testid: `screen-${opts.id}` } },
    h('div', { class: ['box', opts.wide !== false && 'wide'] }, header, body),
  );
  return { el, body, header };
}

/** A Back button (B on a gamepad, Esc on the keyboard): to the menu, or `onClick`. */
export function backButton(app: App, onClick: () => void = () => app.go('menu')): HTMLElement {
  return h(
    'button',
    {
      class: 'btn small ghost back-btn',
      dataset: { testid: 'back', back: '' },
      on: { click: onClick },
    },
    t('collection.back'),
    inputHint(['Esc'], ['b']),
  );
}

/**
 * The input prompts along the bottom of a screen: `[keys, pad buttons, label]` each, as keys with
 * the keyboard and glyphs with a gamepad (hidden on touch, which has neither).
 */
export function keyHints(
  hints: readonly (readonly [readonly string[], readonly PadButton[], string])[],
): HTMLElement {
  return h(
    'div',
    { class: 'key-hints', 'aria-hidden': 'true' },
    hints.map(([keys, buttons, label]) => h('span', null, inputHint(keys, buttons), label)),
  );
}

export function loadingView(): HTMLElement {
  return h(
    'div',
    { class: 'loading-view', role: 'status' },
    h('span', { class: 'spinner' }),
    t('login.loading'),
  );
}

export function errorView(err: unknown, retry: () => void): HTMLElement {
  return h(
    'div',
    { class: 'error-view', role: 'alert' },
    h('p', null, errorText(err)),
    h('button', { class: 'btn small', on: { click: retry } }, t('app.retry')),
  );
}

/**
 * Loads data into `el`: a spinner while waiting, an error with a retry button if it fails, then
 * `show(data)`. Returns a function that reloads.
 */
export function loadInto<T>(el: HTMLElement, load: () => Promise<T>, show: (data: T) => void) {
  let token = 0;
  const run = () => {
    const mine = ++token;
    replace(el, loadingView());
    load().then(
      (data) => {
        if (mine === token && el.isConnected) show(data);
      },
      (err: unknown) => {
        if (mine === token) replace(el, errorView(err, run));
      },
    );
  };
  run();
  return run;
}

/** Segmented control / tabs: buttons with `.on` on the current one. */
export function tabs<T extends string>(
  items: readonly { id: T; label: string | Node; testid?: string }[],
  current: T,
  onPick: (id: T) => void,
  cls = 'tabs',
): HTMLElement {
  return h(
    'div',
    { class: cls, role: 'tablist' },
    items.map((it) =>
      h(
        'button',
        {
          class: ['tab', it.id === current && 'on'],
          role: 'tab',
          'aria-selected': it.id === current ? 'true' : 'false',
          dataset: it.testid ? { testid: it.testid } : undefined,
          on: { click: () => onPick(it.id) },
        },
        it.label,
      ),
    ),
  );
}
