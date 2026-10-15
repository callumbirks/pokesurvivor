// The "new version" prompt: when the server says it runs a different build than this bundle (a
// deploy happened since the page loaded), offer a reload without forcing one. Never during a run:
// the prompt waits for the run to end. A dismissed prompt comes back on the next screen change, or
// after `remindMs`. DOM-free; the app shell draws it.

export interface UpdatePromptView {
  /** Shows (or keeps showing) the prompt for the server's `version`. */
  show(version: string): void;
  hide(): void;
}

export interface UpdatePromptOptions {
  /** A dismissed prompt comes back after this long. */
  remindMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

export const REMIND_MS = 5 * 60_000;

export class UpdatePrompt {
  /** The server's version label while its build differs from ours, else null. */
  private available: string | null = null;
  private inRun = false;
  private dismissed = false;
  private shown: string | null = null;
  private timer: unknown = null;
  private readonly remindMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  /** `build` is this bundle's build id: empty in development, where nothing is ever prompted. */
  constructor(
    private readonly build: string,
    private readonly view: UpdatePromptView,
    opts: UpdatePromptOptions = {},
  ) {
    this.remindMs = opts.remindMs ?? REMIND_MS;
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  /** Whether the prompt is on screen. */
  get visible(): boolean {
    return this.shown !== null;
  }

  /**
   * The server's build, from `welcome` or an API response. The latest one wins: a client that
   * reconnects to a server of its own build (a rollback) stops prompting.
   */
  server(build: string | undefined, version: string | undefined): void {
    if (!this.build || !build) return;
    const next = build === this.build ? null : version || build;
    if (next === this.available) return;
    this.available = next;
    this.update();
  }

  /** Each screen change: `inRun` while a run (solo or coop) is on screen. Undoes a dismiss. */
  screen(inRun: boolean): void {
    this.inRun = inRun;
    if (!inRun) this.undismiss();
    this.update();
  }

  /** The player closed the prompt: hidden until the next screen change or `remindMs`. */
  dismiss(): void {
    this.dismissed = true;
    this.clear();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.dismissed = false;
      this.update();
    }, this.remindMs);
    this.update();
  }

  private undismiss(): void {
    this.dismissed = false;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private update(): void {
    const show = this.available !== null && !this.inRun && !this.dismissed;
    const next = show ? this.available : null;
    if (next === this.shown) return;
    this.shown = next;
    if (next === null) this.view.hide();
    else this.view.show(next);
  }
}
