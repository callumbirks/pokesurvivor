import { describe, expect, it } from 'vitest';
import { clockText, secondsLeft } from './countdown.js';

describe('countdowns', () => {
  it('shows m:ss, rounded up, never negative', () => {
    expect(clockText(30_000, 0)).toBe('0:30');
    expect(clockText(29_001, 0)).toBe('0:30');
    expect(clockText(90_000, 0)).toBe('1:30');
    expect(clockText(500, 0)).toBe('0:01');
    expect(clockText(0, 0)).toBe('0:00');
    expect(clockText(0, 5000)).toBe('0:00');
  });

  it('counts whole seconds for 3-2-1', () => {
    expect(secondsLeft(3000, 0)).toBe(3);
    expect(secondsLeft(3000, 1)).toBe(3);
    expect(secondsLeft(3000, 2500)).toBe(1);
    expect(secondsLeft(3000, 3000)).toBe(0);
  });
});
