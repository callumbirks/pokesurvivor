// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { t } from '@pokesurvivor/data';
import { ResumeCountdown, clockText, secondsLeft } from './countdown.js';

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

describe('the resume countdown', () => {
  it('counts down over the game, then goes away', () => {
    const layer = document.createElement('div');
    const countdown = new ResumeCountdown(layer);
    const shown = () => [...layer.querySelectorAll('.ps-resume')].map((e) => e.textContent);
    countdown.show(3);
    expect(shown()).toEqual([t('game.noticeResuming', { 0: '3' })]);
    countdown.show(1);
    expect(shown()).toEqual([t('game.noticeResuming', { 0: '1' })]);
    countdown.show(0);
    expect(shown()).toEqual([]);
  });
});
