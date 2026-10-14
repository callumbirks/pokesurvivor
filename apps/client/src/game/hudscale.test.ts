// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../settings.js';
import { autoHudScale, hudScale } from './hudscale.js';
import { TouchControls } from './touch.js';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('HUD scale', () => {
  it('grows with large windows and never shrinks small ones', () => {
    expect(autoHudScale(1280, 720)).toBe(1);
    expect(autoHudScale(1920, 1080)).toBe(1.5);
    expect(autoHudScale(2560, 1440)).toBe(2);
    expect(autoHudScale(3840, 2160)).toBe(2); // capped
    // An ultrawide follows its height; a tall window its width.
    expect(autoHudScale(3440, 1440)).toBe(2);
    expect(autoHudScale(1920, 900)).toBe(1.25);
    expect(autoHudScale(1920, 600)).toBe(1); // short: never below 1
    // Phones and small windows: as before.
    expect(autoHudScale(863, 360)).toBe(1); // Pixel 7, landscape
    expect(autoHudScale(390, 844)).toBe(1); // iPhone, portrait
    expect(autoHudScale(1024, 600)).toBe(1);
    expect(autoHudScale(0, 0)).toBe(1);
  });

  it('is the automatic scale on Auto, else the fixed scale set, within 75–200%', () => {
    expect(hudScale(1920, 1080, 'auto')).toBe(1.5);
    expect(hudScale(863, 360, 'auto')).toBe(1);
    // A fixed scale is absolute: 100% is the original size on any window.
    expect(hudScale(1920, 1080, 1)).toBe(1);
    expect(hudScale(1920, 1080, 1.5)).toBe(1.5);
    expect(hudScale(863, 360, 2)).toBe(2);
    expect(hudScale(863, 360, 0.75)).toBe(0.75);
    expect(hudScale(863, 360, 9)).toBe(2);
    expect(hudScale(863, 360, 0.1)).toBe(0.75);
    expect(hudScale(863, 360, Number.NaN)).toBe(1);
    // Rounded to 1/40 so resizing doesn't make text shimmer.
    expect((hudScale(1500, 1000, 'auto') * 40) % 1).toBe(0);
    expect(hudScale(800, 600, 1.234)).toBe(1.225);
  });

  it('is a per-device setting: Auto by default, stored locally, clamped, not synced', () => {
    const storage = memoryStorage();
    const a = new SettingsStore(storage);
    expect(a.get().hudSize).toBe('auto');
    a.set({ hudSize: 1.25 });
    expect(new SettingsStore(storage).get().hudSize).toBe(1.25);
    a.set({ hudSize: 4 });
    expect(a.get().hudSize).toBe(2);
    a.set({ hudSize: 0.1 });
    expect(a.get().hudSize).toBe(0.75);
    a.set({ hudSize: 'auto' });
    expect(new SettingsStore(storage).get().hudSize).toBe('auto');
    expect('hudSize' in a.synced()).toBe(false);
  });

  it('starts old saves on Auto (their hudScale was a multiplier of the automatic size)', () => {
    const storage = memoryStorage();
    storage.setItem('ps.settings', JSON.stringify({ hudScale: 1.5, musicVolume: 0.3 }));
    const s = new SettingsStore(storage).get();
    expect(s.hudSize).toBe('auto');
    expect(s.musicVolume).toBe(0.3);
  });
});

describe('HUD buttons at a scale', () => {
  it('are hit where they are drawn: added in HUD px, tested in CSS px', () => {
    const el = document.createElement('div');
    document.body.append(el);
    const touch = new TouchControls(el, () => true);
    touch.buttonScale = 1.5;
    // A 54-px move slot at (100, 400) in HUD px is drawn at (150, 600) and 81 px wide on screen.
    touch.addButton(100, 400, 54, 54, () => {}, 0);
    expect(touch.hitsButton(150 + 80, 600 + 80)).toBe(true);
    expect(touch.hitsButton(150 + 1, 600 + 1)).toBe(true);
    expect(touch.hitsButton(100 + 10, 400 + 10)).toBe(false); // where it would be unscaled
    expect(touch.hitsButton(150 + 82, 600 + 40)).toBe(false);
    touch.dispose();
  });
});
