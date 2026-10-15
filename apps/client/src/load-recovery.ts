// Recovers from a bundle, chunk or worker that fails to load, e.g. a tab opened before a deploy
// asking for a chunk the new server no longer has, or a 404 for a new chunk cached during the
// deploy's overlap. Without this the page stays blank until a hard refresh (docs/deploy.md).
//
// `installLoadRecovery` runs as an inline script in index.html (vite.config.ts injects its
// source), so it also works when the main bundle is what failed. It must stay self-contained:
// no imports, nothing from module scope; everything it needs comes in its arguments.

export interface RecoveryOptions {
  /** Shown instead of a second reload. */
  message: string;
  /** sessionStorage key: when this tab last reloaded to recover. */
  key: string;
  /** A failure within this long of the recovery reload shows the message instead. */
  windowMs: number;
  /** The `window` property the bundle calls when one of its lazy loads fails. */
  hook: string;
}

export const RECOVERY_OPTIONS: Omit<RecoveryOptions, 'message'> = {
  key: 'pokesurvivor.loadRecoveryAt',
  windowMs: 2 * 60_000,
  hook: '__pokesurvivorLoadFailed',
};

/** What `installLoadRecovery` needs from `window` (a fake one in tests). */
export interface RecoveryWindow {
  addEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
  location: Pick<Location, 'reload' | 'origin'>;
  document: Document;
  fetch(url: string, init: RequestInit): Promise<unknown>;
  setTimeout(fn: () => void, ms: number): unknown;
  Date: { now(): number };
}

/**
 * Watches for load failures: an `/assets/` script or stylesheet that fails (the main bundle and
 * its static imports), Vite's `vite:preloadError` (a lazy chunk), and `window[hook](url?)`, which
 * the bundle calls itself (`loadFailed`: a failed `import()`, the solo worker). The first failure
 * refetches the failed file past the browser cache and reloads; another failure within
 * `windowMs` of that reload shows `message` instead, so it can never loop.
 */
export function installLoadRecovery(win: RecoveryWindow, opts: RecoveryOptions): void {
  const assets = win.location.origin + '/assets/';
  let handled = false;
  const showMessage = () => {
    const doc = win.document;
    const box = doc.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;background:#050914;color:#fff;' +
      'font:18px/1.5 system-ui,sans-serif;text-align:center';
    box.textContent = opts.message;
    if (doc.body) doc.body.append(box);
    else doc.addEventListener('DOMContentLoaded', () => doc.body.append(box));
  };
  const failed = (url?: string) => {
    if (handled) return;
    handled = true;
    const now = win.Date.now();
    try {
      const last = Number(win.sessionStorage.getItem(opts.key));
      if (now - last < opts.windowMs) return showMessage();
      win.sessionStorage.setItem(opts.key, String(now));
    } catch {
      // No sessionStorage: nothing would stop a reload loop.
      return showMessage();
    }
    let reloading = false;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      win.location.reload();
    };
    // A plain reload reuses cached sub-resources: refetching the failed file with
    // `cache: 'reload'` replaces a 404 the browser cached (before errors were `no-store`).
    if (!url || url.indexOf(assets) !== 0) return reload();
    win.setTimeout(reload, 3000);
    win.fetch(url, { cache: 'reload' }).then(reload, reload);
  };
  const assetUrlIn = (err: unknown) => {
    const match = /\/assets\/[^\s'"()]+/.exec(err instanceof Error ? err.message : String(err));
    return match ? win.location.origin + match[0] : undefined;
  };
  (win as unknown as Record<string, unknown>)[opts.hook] = (err?: unknown) =>
    failed(err === undefined ? undefined : assetUrlIn(err));
  win.addEventListener(
    'error',
    (event) => {
      // Resource errors don't bubble: this listener captures them.
      const el = event.target as { tagName?: string; src?: string; href?: string } | null;
      const url = el?.tagName === 'SCRIPT' ? el.src : el?.tagName === 'LINK' ? el.href : '';
      if (url && url.indexOf(assets) === 0) failed(url);
    },
    true,
  );
  win.addEventListener('vite:preloadError', (event) =>
    failed(assetUrlIn((event as Event & { payload?: unknown }).payload)),
  );
}

/** Reports a lazy load that failed (an `import()`, the solo worker) to the inline recovery. */
export function loadFailed(err?: unknown): void {
  console.error('[load] failed:', err);
  const hook = (window as unknown as Record<string, ((err?: unknown) => void) | undefined>)[
    RECOVERY_OPTIONS.hook
  ];
  hook?.(err);
}
