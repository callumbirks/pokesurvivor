// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { installLoadRecovery, RECOVERY_OPTIONS, type RecoveryWindow } from './load-recovery.js';

const ORIGIN = 'https://game.example';
const MESSAGE = 'Please hard-refresh';

/** A fresh page load in a tab whose sessionStorage is `storage`. */
function page(storage: Map<string, string>, now = 1_000_000, opts: { noStorage?: boolean } = {}) {
  const log: string[] = [];
  const listeners = new Map<string, (event: Event) => void>();
  let fetched: (() => void) | null = null;
  document.body.innerHTML = '';
  const win: RecoveryWindow = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    sessionStorage: {
      getItem: (key) => {
        if (opts.noStorage) throw new Error('blocked');
        return storage.get(key) ?? null;
      },
      setItem: (key, value) => void storage.set(key, value),
    },
    location: { origin: ORIGIN, reload: () => log.push('reload') },
    document,
    fetch: (url, init) => {
      log.push(`fetch ${url} ${init.cache}`);
      return new Promise((resolve) => (fetched = () => resolve(undefined)));
    },
    setTimeout: () => log.push('timer'),
    Date: { now: () => now },
  };
  installLoadRecovery(win, { ...RECOVERY_OPTIONS, message: MESSAGE });
  const hook = (win as unknown as Record<string, (err?: unknown) => void>)[RECOVERY_OPTIONS.hook]!;
  return {
    log,
    hook,
    /** A resource error, as the capture listener sees it. */
    resourceError(tagName: string, url: string) {
      const target = tagName === 'SCRIPT' ? { tagName, src: url } : { tagName, href: url };
      listeners.get('error')!({ target } as unknown as Event);
    },
    preloadError(message: string) {
      listeners.get('vite:preloadError')!({ payload: new Error(message) } as unknown as Event);
    },
    finishFetch: () => fetched?.(),
    message: () => document.body.querySelector('[role=alert]')?.textContent ?? null,
  };
}

describe('load recovery', () => {
  it('refetches a failed bundle past the cache, then reloads once', async () => {
    const storage = new Map<string, string>();
    const p = page(storage);
    p.resourceError('SCRIPT', `${ORIGIN}/assets/index-abc.js`);
    p.resourceError('LINK', `${ORIGIN}/assets/index-abc.css`);
    expect(p.log).toEqual(['timer', `fetch ${ORIGIN}/assets/index-abc.js reload`]);
    p.finishFetch();
    await Promise.resolve();
    expect(p.log.at(-1)).toBe('reload');
    expect(storage.get(RECOVERY_OPTIONS.key)).toBe('1000000');
    expect(p.message()).toBeNull();
  });

  it('shows the message instead of reloading again', () => {
    const storage = new Map<string, string>();
    page(storage).hook(new TypeError('Failed to fetch dynamically imported module'));
    const again = page(storage, 1_000_000 + RECOVERY_OPTIONS.windowMs - 1);
    again.preloadError(`Failed to fetch dynamically imported module: ${ORIGIN}/assets/x.js`);
    expect(again.log).toEqual([]);
    expect(again.message()).toBe(MESSAGE);
  });

  it('reloads again for a failure long after the last recovery (a later deploy)', () => {
    const storage = new Map<string, string>();
    page(storage).hook();
    const later = page(storage, 1_000_000 + RECOVERY_OPTIONS.windowMs);
    later.hook();
    expect(later.log).toEqual(['reload']);
  });

  it('finds the chunk in a preload error', () => {
    const p = page(new Map());
    p.preloadError(`Failed to fetch dynamically imported module: ${ORIGIN}/assets/menu-1.js`);
    expect(p.log).toContain(`fetch ${ORIGIN}/assets/menu-1.js reload`);
  });

  it('ignores errors that are not our assets', () => {
    const p = page(new Map());
    p.resourceError('SCRIPT', 'https://cdn.example/assets/x.js');
    p.resourceError('IMG', `${ORIGIN}/assets/x.png`);
    expect(p.log).toEqual([]);
  });

  it("doesn't reload without sessionStorage to guard it", () => {
    const p = page(new Map(), 1_000_000, { noStorage: true });
    p.hook();
    expect(p.log).toEqual([]);
    expect(p.message()).toBe(MESSAGE);
  });
});
