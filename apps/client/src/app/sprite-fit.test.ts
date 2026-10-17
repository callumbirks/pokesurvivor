import { loadSpriteManifest } from '@pokesurvivor/data/sprites';
import { describe, expect, it } from 'vitest';
import { fitScale, spriteLayout, visualBox } from '../sprites.js';

const manifest = loadSpriteManifest();
const pokemon = (dex: number) => {
  const p = manifest.byDex.get(dex);
  if (!p) throw new Error(`no sprite for ${dex}`);
  return p;
};
const idle = (dex: number) => pokemon(dex).animations.Idle!;

/**
 * The fixed containers that stand sprites on their bottom edge (the `fit` box and the CSS):
 * the content height above the baseline, and the margin from the baseline to the border
 * (padding + border).
 */
const CONTAINERS = {
  'menu partner card': { scale: 4, box: { width: 256, height: 170 }, content: 170, margin: 15 },
  'solo / collection / starter stage': {
    scale: 4,
    box: { width: 216, height: 150 },
    content: 150,
    margin: 15,
  },
  'stage (phone)': { scale: 4, box: { width: 130, height: 96 }, content: 150, margin: 11 },
  'shop stage': { scale: 2, box: { width: 110, height: 64 }, content: 66, margin: 15 },
  'gacha banner': { scale: 2, box: { width: 210, height: 144 }, content: 154, margin: 16 },
  'gacha banner (phone)': { scale: 2, box: { width: 104, height: 86 }, content: 94, margin: 16 },
  'gacha card': { scale: 2, box: { width: 128, height: 96 }, content: 112, margin: 8 },
  'gacha card (phone)': { scale: 2, box: { width: 84, height: 60 }, content: 68, margin: 8 },
  'collection cell': { scale: 1.5, box: { width: 80, height: 58 }, content: 60, margin: 6 },
  'list row': { scale: 1, box: { width: 44, height: 36 }, content: 37, margin: 3 },
  'run results shiny': { scale: 2, box: { width: 96, height: 72 }, content: 78, margin: 6 },
};

describe('fitScale', () => {
  it('keeps the view scale when the sprite fits', () => {
    expect(fitScale(idle(25), 2, { width: 210, height: 144 })).toBe(2); // Pikachu
    expect(fitScale(idle(25), 2)).toBe(2);
  });

  it('shrinks the giants to a whole scale', () => {
    // Eternatus: ×2 on the banner, ×1 on a reveal card.
    expect(fitScale(idle(890), 2, { width: 210, height: 144 })).toBe(2);
    expect(fitScale(idle(890), 2, { width: 128, height: 96 })).toBe(1);
    expect(Number.isInteger(fitScale(idle(384), 4, { width: 216, height: 150 }))).toBe(true);
  });
});

describe('visualBox', () => {
  it('reaches below the anchor where the art does (the partner card bug)', () => {
    // Appletun's art goes 4.5 px below its anchor: standing it on the anchor cut it off.
    const v = visualBox(idle(842), pokemon(842).shadowSize);
    expect(v.bottom).toBeGreaterThan(idle(842).anchorY);
    expect(v.bottom).toBeGreaterThanOrEqual(idle(842).bounds.bottom);
  });
});

describe('sprites standing in their containers', () => {
  for (const [name, c] of Object.entries(CONTAINERS)) {
    it(`every Pokémon, shadow included, sits inside the ${name} with a margin`, () => {
      for (const p of manifest.pokemon) {
        const frame = p.animations.Idle!;
        const lay = spriteLayout(frame, {
          scale: c.scale,
          box: c.box,
          shadowSize: p.shadowSize,
          feet: true,
        });
        // The element's bottom edge hangs -marginBottom below the baseline (y = 0, up is
        // negative); what it shows spans visualTop..visualBottom from its top edge.
        const top = -lay.marginBottom - lay.height;
        const shownBottom = top + lay.visualBottom;
        const shownTop = top + lay.visualTop;
        const where = `#${p.dex} in the ${name}`;
        // The lowest pixel, art or shadow, is on the baseline: `margin` px above the border.
        expect(shownBottom, where).toBeCloseTo(0, 6);
        expect(c.margin, where).toBeGreaterThanOrEqual(3);
        // Nothing reaches above the content area, and it fits the width.
        expect(-shownTop, where).toBeLessThanOrEqual(c.content + 1e-9);
        const v = visualBox(frame, p.shadowSize);
        expect((v.right - v.left) * lay.scale, where).toBeLessThanOrEqual(c.box.width + 1e-9);
        expect(lay.scale, where).toBeLessThanOrEqual(c.scale);
      }
    });
  }
});
