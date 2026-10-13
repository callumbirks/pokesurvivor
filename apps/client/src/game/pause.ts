// The pause menu's states (no DOM, so it's testable): playing, the pause menu, or the full
// settings screen opened from it.
//
// Solo: the pause menu pauses the run (the worker's sim waits) and it stays paused while the
// settings are open; closing them goes back to the pause menu. Leaving the app or turning a phone
// upright pauses it on its own (legacy game.js `autoPause`).
// Multiplayer: the run never stops for one player. The pause menu and the settings are just
// overlays; closing the settings goes straight back to the game, and nothing pauses on its own.

export type PauseView = 'playing' | 'menu' | 'settings';

export interface PauseDeps {
  /** A solo run (the only kind that can pause). */
  solo: boolean;
  /** Solo: pause or resume the run. */
  setPaused(paused: boolean): void;
  /** Shows the view (called on every change). */
  render(view: PauseView, prev: PauseView): void;
}

export class PauseFlow {
  private current: PauseView = 'playing';
  private paused = false;

  constructor(private readonly deps: PauseDeps) {}

  get view(): PauseView {
    return this.current;
  }

  /** Solo: is the run paused by this menu? */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Esc / P / the pause button: opens the menu, closes it, or closes the settings. */
  toggle(): void {
    if (this.current === 'playing') this.open();
    else if (this.current === 'menu') this.resume();
    else this.closeSettings();
  }

  open(): void {
    if (this.current !== 'playing') return;
    this.pause(true);
    this.go('menu');
  }

  /** "Continue": back to the game. */
  resume(): void {
    if (this.current === 'playing') return;
    this.go('playing');
    this.pause(false);
  }

  openSettings(): void {
    if (this.current !== 'menu') return;
    this.go('settings');
  }

  /** The settings' back button (or Esc): the pause menu in solo, the game in multiplayer. */
  closeSettings(): void {
    if (this.current !== 'settings') return;
    if (this.deps.solo) this.go('menu');
    else this.go('playing');
  }

  /** The tab was hidden or the phone turned upright: solo runs pause; multiplayer ones don't. */
  autoPause(): void {
    if (this.deps.solo) this.open();
  }

  /** The run ended (results): close everything, without resuming. */
  close(): void {
    if (this.current === 'playing') return;
    this.go('playing');
    this.paused = false;
  }

  private pause(p: boolean): void {
    if (!this.deps.solo || this.paused === p) return;
    this.paused = p;
    this.deps.setPaused(p);
  }

  private go(view: PauseView): void {
    const prev = this.current;
    if (prev === view) return;
    this.current = view;
    this.deps.render(view, prev);
  }
}
