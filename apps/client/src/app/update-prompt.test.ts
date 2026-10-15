import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdatePrompt } from './update-prompt.js';

function setup(build = 'b1') {
  const log: string[] = [];
  const prompt = new UpdatePrompt(
    build,
    { show: (v) => log.push(`show ${v}`), hide: () => log.push('hide') },
    { remindMs: 1000 },
  );
  return { prompt, log };
}

describe('UpdatePrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prompts on a menu as soon as the server runs another build', () => {
    const { prompt, log } = setup();
    prompt.screen(false);
    prompt.server('b1', 'v10');
    expect(prompt.visible).toBe(false);
    prompt.server('b2', 'v11');
    expect(prompt.visible).toBe(true);
    // Repeats (every API response) don't redraw it.
    prompt.server('b2', 'v11');
    expect(log).toEqual(['show v11']);
  });

  it('never prompts without a build id on either side (development)', () => {
    const dev = setup('');
    dev.prompt.screen(false);
    dev.prompt.server('b2', 'v11');
    expect(dev.prompt.visible).toBe(false);
    const { prompt } = setup();
    prompt.screen(false);
    prompt.server(undefined, undefined);
    prompt.server('', 'v11');
    expect(prompt.visible).toBe(false);
  });

  it('waits for a run to end', () => {
    const { prompt, log } = setup();
    prompt.screen(true);
    prompt.server('b2', 'v11');
    expect(prompt.visible).toBe(false);
    prompt.screen(true);
    expect(prompt.visible).toBe(false);
    prompt.screen(false);
    expect(prompt.visible).toBe(true);
    expect(log).toEqual(['show v11']);
  });

  it('hides when a run starts while it is shown', () => {
    const { prompt } = setup();
    prompt.screen(false);
    prompt.server('b2', 'v11');
    prompt.screen(true);
    expect(prompt.visible).toBe(false);
    prompt.screen(false);
    expect(prompt.visible).toBe(true);
  });

  it('comes back after a dismiss on the next screen change', () => {
    const { prompt } = setup();
    prompt.screen(false);
    prompt.server('b2', 'v11');
    prompt.dismiss();
    expect(prompt.visible).toBe(false);
    prompt.server('b2', 'v11');
    expect(prompt.visible).toBe(false);
    prompt.screen(false);
    expect(prompt.visible).toBe(true);
  });

  it('comes back after a dismiss after a while, but not during a run', () => {
    const { prompt } = setup();
    prompt.screen(false);
    prompt.server('b2', 'v11');
    prompt.dismiss();
    vi.advanceTimersByTime(999);
    expect(prompt.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(prompt.visible).toBe(true);

    prompt.dismiss();
    prompt.screen(true);
    vi.advanceTimersByTime(1000);
    expect(prompt.visible).toBe(false);
    prompt.screen(false);
    expect(prompt.visible).toBe(true);
  });

  it('follows the latest server: a newer build updates it, our own build clears it', () => {
    const { prompt, log } = setup();
    prompt.screen(false);
    prompt.server('b2', 'v11');
    prompt.server('b3', 'v12');
    prompt.server('b1', 'v10');
    expect(log).toEqual(['show v11', 'show v12', 'hide']);
  });
});
