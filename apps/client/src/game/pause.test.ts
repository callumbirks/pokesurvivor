import { describe, expect, it } from 'vitest';
import { PauseFlow, type PauseView } from './pause.js';

function flow(solo: boolean) {
  const paused: boolean[] = [];
  const views: PauseView[] = [];
  const f = new PauseFlow({
    solo,
    setPaused: (p) => paused.push(p),
    render: (v) => views.push(v),
  });
  return { f, paused, views };
}

describe('pause menu and settings: solo', () => {
  it('pauses on opening and resumes on continue', () => {
    const { f, paused, views } = flow(true);
    f.toggle();
    expect(f.view).toBe('menu');
    expect(f.isPaused).toBe(true);
    f.resume();
    expect(f.view).toBe('playing');
    expect(paused).toEqual([true, false]);
    expect(views).toEqual(['menu', 'playing']);
  });

  it('stays paused in the settings and comes back to the pause menu', () => {
    const { f, paused } = flow(true);
    f.open();
    f.openSettings();
    expect(f.view).toBe('settings');
    expect(f.isPaused).toBe(true);
    f.closeSettings();
    expect(f.view).toBe('menu');
    expect(f.isPaused).toBe(true);
    expect(paused).toEqual([true]);
    // Esc in the settings is their back button too.
    f.openSettings();
    f.toggle();
    expect(f.view).toBe('menu');
    f.toggle();
    expect(f.view).toBe('playing');
    expect(paused).toEqual([true, false]);
  });

  it('pauses on its own (tab hidden, phone upright), once', () => {
    const { f, paused } = flow(true);
    f.autoPause();
    f.autoPause();
    expect(f.view).toBe('menu');
    expect(paused).toEqual([true]);
    // Not over the settings.
    f.openSettings();
    f.autoPause();
    expect(f.view).toBe('settings');
  });

  it('closes without resuming when the run ends', () => {
    const { f, paused } = flow(true);
    f.open();
    f.openSettings();
    f.close();
    expect(f.view).toBe('playing');
    expect(f.isPaused).toBe(false);
    expect(paused).toEqual([true]);
  });
});

describe('pause menu and settings: multiplayer', () => {
  it('never pauses the run', () => {
    const { f, paused } = flow(false);
    f.open();
    f.openSettings();
    f.closeSettings();
    f.autoPause();
    expect(paused).toEqual([]);
    expect(f.isPaused).toBe(false);
  });

  it('goes straight back to the game from the settings', () => {
    const { f, views } = flow(false);
    f.open();
    f.openSettings();
    f.closeSettings();
    expect(f.view).toBe('playing');
    expect(views).toEqual(['menu', 'settings', 'playing']);
  });

  it("doesn't open the pause menu on its own", () => {
    const { f } = flow(false);
    f.autoPause();
    expect(f.view).toBe('playing');
  });
});
