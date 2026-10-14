import { describe, expect, it } from 'vitest';
import { crosshairOutline } from './game/aim.js';
import { CROSSHAIR_COLORS, SettingsStore, sanitizeSettings } from './settings.js';

function storeWith(stored: unknown) {
  const data = new Map<string, string>([['ps.settings', JSON.stringify(stored)]]);
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  return { store: new SettingsStore(storage), data };
}

describe('crosshair colour setting', () => {
  it('is magenta by default', () => {
    expect(storeWith({}).store.get().crosshairColor).toBe('magenta');
    expect(CROSSHAIR_COLORS.magenta).toBe('#ff00ff');
  });

  it('loads a saved colour', () => {
    expect(storeWith({ crosshairColor: 'cyan' }).store.get().crosshairColor).toBe('cyan');
  });

  it('falls back to magenta for unknown or malformed values', () => {
    for (const bad of ['purple', '#ff00ff', 'constructor', 'toString', 3, null, { a: 1 }])
      expect(storeWith({ crosshairColor: bad }).store.get().crosshairColor).toBe('magenta');
    expect(sanitizeSettings({ crosshairColor: 'teal' })).not.toHaveProperty('crosshairColor');
  });

  it('is stored on the device and not synced to the account', () => {
    const { store, data } = storeWith({});
    store.set({ crosshairColor: 'green' });
    expect(JSON.parse(data.get('ps.settings')!)).toMatchObject({ crosshairColor: 'green' });
    expect(store.synced()).not.toHaveProperty('crosshairColor');
  });

  it('every colour gets a contrasting outline', () => {
    expect(crosshairOutline(CROSSHAIR_COLORS.magenta)).toMatch(/^rgba\(10,/);
    expect(crosshairOutline(CROSSHAIR_COLORS.white)).toMatch(/^rgba\(10,/);
    expect(crosshairOutline(CROSSHAIR_COLORS.black)).toMatch(/^rgba\(244,/);
  });

  it('loads the crosshair size, clamped to 0.25–3, 1 by default', () => {
    expect(storeWith({}).store.get().crosshairScale).toBe(1);
    expect(storeWith({ crosshairScale: 1.25 }).store.get().crosshairScale).toBe(1.25);
    expect(storeWith({ crosshairScale: 0.1 }).store.get().crosshairScale).toBe(0.25);
    expect(storeWith({ crosshairScale: 9 }).store.get().crosshairScale).toBe(3);
    for (const bad of ['2', null, Number.NaN, Infinity])
      expect(storeWith({ crosshairScale: bad }).store.get().crosshairScale).toBe(1);
    expect(storeWith({}).store.synced()).not.toHaveProperty('crosshairScale');
  });
});
