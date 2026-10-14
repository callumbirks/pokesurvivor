import { describe, expect, it, vi } from 'vitest';
import { quantizeAim } from '@pokesurvivor/protocol';
import { SettingsStore } from '../settings.js';
import { AIM_KEY, AimTracker, aimKey, toggleAimMode } from './aim.js';
import { Hud, type HudInput } from './hud.js';
import type { TouchControls } from './touch.js';

function memoryStore() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  return { store: new SettingsStore(storage), storage, data };
}

describe('aim mode', () => {
  it('is auto by default, and T switches it and is remembered', () => {
    const { store, storage } = memoryStore();
    expect(store.get().aimMode).toBe('auto');
    expect(AIM_KEY).toBe('KeyT');
    expect(aimKey('KeyT', store)).toBe(true);
    expect(store.get().aimMode).toBe('manual');
    // A new store (a reload) reads it back.
    expect(new SettingsStore(storage).get().aimMode).toBe('manual');
    expect(aimKey('KeyQ', store)).toBe(false);
    expect(store.get().aimMode).toBe('manual');
    toggleAimMode(store);
    expect(store.get().aimMode).toBe('auto');
  });

  it('ignores bad stored values', () => {
    const { store } = memoryStore();
    store.set({ aimMode: 'sideways' as never });
    expect(store.get().aimMode).toBe('auto');
  });

  it('the HUD button switches it, by click or tap', () => {
    const { store } = memoryStore();
    const buttons: { x: number; y: number; w: number; h: number; fn: () => void }[] = [];
    const touch = {
      active: false,
      safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
      addButton: (x: number, y: number, w: number, h: number, fn: () => void) =>
        buttons.push({ x, y, w, h, fn }),
    } as unknown as TouchControls;
    // A canvas context that draws nothing (and measures text as 6 px a character).
    const ctx = new Proxy(
      {},
      {
        get: (_t, key) =>
          key === 'measureText' ? (s: string) => ({ width: s.length * 6 }) : vi.fn(),
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    const k = {
      w: 800,
      h: 450,
      touch,
      aimMode: store.get().aimMode,
      toggleAim: () => toggleAimMode(store),
    } as unknown as HudInput;
    new Hud().drawAimToggle(ctx, k);
    expect(buttons).toHaveLength(1);
    const b = buttons[0]!;
    // Top right.
    expect(b.x + b.w).toBeLessThanOrEqual(800);
    expect(b.x).toBeGreaterThan(600);
    b.fn();
    expect(store.get().aimMode).toBe('manual');
  });
});

describe('aim tracker', () => {
  it('sends nothing in auto mode', () => {
    const { store } = memoryStore();
    const aim = new AimTracker(store);
    aim.mouseMove(500, 100);
    aim.update(null, [100, 100], 1);
    expect(aim.input()).toBeNull();
  });

  it('starts from the server aim, then follows the mouse around our Pokémon', () => {
    const { store } = memoryStore();
    store.set({ aimMode: 'manual' });
    const aim = new AimTracker(store);
    aim.update(null, [100, 100], 2);
    expect(aim.input()).toBe(quantizeAim(2));
    aim.mouseMove(100, 300); // straight below
    aim.update(null, [100, 100], 2);
    expect(aim.input()).toBeCloseTo(Math.PI / 2, 5);
    // The Pokémon walks under the cursor: the aim turns with it.
    aim.update(null, [100, 400], 2);
    expect(aim.input()).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('a stick takes over and its last direction stays when it is let go', () => {
    const { store } = memoryStore();
    store.set({ aimMode: 'manual' });
    const aim = new AimTracker(store);
    aim.mouseMove(300, 100);
    aim.update([-1, 0], [100, 100], 0);
    expect(Math.abs(aim.input()!)).toBeCloseTo(Math.PI, 5);
    aim.update(null, [100, 100], 0);
    expect(Math.abs(aim.input()!)).toBeCloseTo(Math.PI, 5);
    // The mouse moves again: it aims.
    aim.mouseMove(100, 0);
    aim.update(null, [100, 100], 0);
    expect(aim.input()).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('sends angles snapped to what the server sees', () => {
    const { store } = memoryStore();
    store.set({ aimMode: 'manual' });
    const aim = new AimTracker(store);
    aim.update([Math.cos(0.3), Math.sin(0.3)], null, null);
    expect(aim.angle).toBeCloseTo(0.3);
    expect(aim.input()).toBe(quantizeAim(0.3));
  });
});

describe('input: T and the gamepad', () => {
  it('passes T through as a key, R3 presses it, and the right stick aims', async () => {
    const listeners = new Map<string, (e: unknown) => void>();
    vi.stubGlobal('addEventListener', (ev: string, fn: (e: unknown) => void) =>
      listeners.set(ev, fn),
    );
    vi.stubGlobal('removeEventListener', () => {});
    const pad = {
      connected: true,
      axes: [0, 0, 0.1, 0.1],
      buttons: Array.from({ length: 16 }, () => ({ pressed: false })),
    };
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    vi.stubGlobal('HTMLInputElement', class {});
    vi.stubGlobal('HTMLTextAreaElement', class {});
    try {
      const { Input } = await import('./input.js');
      const keys: string[] = [];
      const input = new Input((code) => (keys.push(code), true));
      listeners.get('keydown')?.({ code: 'KeyT', repeat: false, preventDefault: () => {} });
      pad.buttons[11]!.pressed = true;
      input.poll();
      expect(keys).toEqual(['KeyT', 'KeyT']);
      // Resting a little off centre doesn't aim; pushed, it does.
      expect(input.aimAxis()).toBeNull();
      pad.axes = [0, 0, -0.9, 0];
      expect(input.aimAxis()).toEqual([-0.9, 0]);
      input.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
