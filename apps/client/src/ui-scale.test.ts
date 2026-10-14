import { describe, expect, it } from 'vitest';
import { uiScale } from './ui-scale.js';

describe('uiScale', () => {
  it('is 1 up to 1280 × 720, and on phones and tall windows', () => {
    expect(uiScale(1280, 720)).toBe(1);
    expect(uiScale(844, 390)).toBe(1);
    expect(uiScale(1080, 1920)).toBe(1);
    expect(uiScale(1600, 900)).toBe(1);
  });

  it('grows in half steps with the smaller side, up to 2', () => {
    expect(uiScale(1920, 1080)).toBe(1.5);
    expect(uiScale(2560, 1440)).toBe(2);
    // Ultrawide: the height decides.
    expect(uiScale(3440, 1440)).toBe(2);
    expect(uiScale(3232, 1398)).toBe(1.5);
    expect(uiScale(5120, 2880)).toBe(2);
  });

  it('is 1 for a window with no size yet', () => {
    expect(uiScale(0, 0)).toBe(1);
    expect(uiScale(Number.NaN, 720)).toBe(1);
  });
});
