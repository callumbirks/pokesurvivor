import { loadSpriteManifest } from '@pokesurvivor/data/sprites';
import { describe, expect, it } from 'vitest';
import { fitScale } from '../sprites.js';

const manifest = loadSpriteManifest();
const idle = (dex: number) => {
  const a = manifest.byDex.get(dex)?.animations.Idle;
  if (!a) throw new Error(`no sprite for ${dex}`);
  return a;
};

// The fixed boxes the screens use (gacha banner and cards, stages, collection cells).
const BOXES = {
  'banner (desktop)': { scale: 2, box: { width: 210, height: 144 } },
  'banner (phone)': { scale: 2, box: { width: 104, height: 86 } },
  'card (desktop)': { scale: 2, box: { width: 128, height: 96 } },
  'card (phone)': { scale: 2, box: { width: 84, height: 60 } },
  'stage (desktop)': { scale: 4, box: { width: 216, height: 150 } },
  'collection cell': { scale: 1.5, box: { width: 80, height: 58 } },
};

describe('fitScale', () => {
  it('keeps the view scale when the sprite fits', () => {
    expect(fitScale(idle(25), 2, { width: 210, height: 144 })).toBe(2); // Pikachu
    expect(fitScale(idle(25), 2)).toBe(2);
  });

  it('shrinks the giants to a whole scale', () => {
    // Eternatus: 104 px wide, 67.5 above its feet: ×2 on the banner, ×1 on a reveal card.
    expect(fitScale(idle(890), 2, { width: 210, height: 144 })).toBe(2);
    expect(fitScale(idle(890), 2, { width: 128, height: 96 })).toBe(1);
    expect(Number.isInteger(fitScale(idle(384), 4, { width: 200, height: 150 }))).toBe(true);
  });

  for (const [name, { scale, box }] of Object.entries(BOXES)) {
    it(`fits every Pokémon in the ${name} box`, () => {
      for (const p of manifest.pokemon) {
        const a = p.animations.Idle;
        const k = fitScale(a, scale, box);
        expect(k).toBeGreaterThan(0);
        expect(k).toBeLessThanOrEqual(scale);
        expect(a.width * k).toBeLessThanOrEqual(box.width + 1e-9);
        expect(a.anchorY * k).toBeLessThanOrEqual(box.height + 1e-9);
      }
    });
  }
});
