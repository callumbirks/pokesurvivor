// The game screen: `mountGame(el, conn, opts)` shows a run from loading to results over any
// `RoomConnection` (the game server's, or the solo Web Worker's). It owns the canvas, the render
// loop, input, the HUD and the overlays (choices, pause, toasts, results); the connection owns the
// game. Contract with the app shell (4b):
//   mountGame(el, conn, { onExit(results?), onLeave?, client?, save?, openSettings? }) → { dispose() }
import { loadGameData, t } from '@pokesurvivor/data';
import type { Game, NetClient, Results, RoomConnection, Snapshot } from '@pokesurvivor/netclient';
import type { SimEvent } from '@pokesurvivor/sim';
import { audio, biomeMusic } from '../audio.js';
import {
  AimTracker,
  MouseFire,
  aimKey,
  drawAimIndicator,
  drawCrosshair,
  toggleAimMode,
} from './aim.js';
import { glyphText, inputHint } from '../glyphs.js';
import { inputDevice, installInputDevice } from '../input-device.js';
import { installMenuNav, menuNav } from '../menu-nav.js';
import { installUiScale } from '../ui-scale.js';
import { CROSSHAIR_COLORS, settings } from '../settings.js';
import { preloadSprites } from '../sprites.js';
import { AchievementTracker, type AchievementSave } from './achievements.js';
import { ChoiceOverlay } from './choice-ui.js';
import { ChoiceState } from './choices.js';
import { clear, el, icon } from './dom.js';
import { EventEffects } from './events.js';
import { MateAlerts, MateBanner } from './mate-alerts.js';
import { buildFrame, type Frame, type SelfView } from './frame.js';
import { Hud, controlsHint } from './hud.js';
import { hudScale } from './hudscale.js';
import { Input } from './input.js';
import { Predictor } from './net/predict.js';
import { NetStatsPanel } from './netstats-ui.js';
import { NOTICE_TEXT } from './notices.js';
import { PauseFlow, type PauseView } from './pause.js';
import { renderResults } from './results.js';
import { Camera } from './scene/camera.js';
import { EntityLayer, LIFT, pokemonName } from './scene/entities.js';
import { FX } from './scene/fx.js';
import { sampleFrame } from './scene/quality.js';
import { WeatherLayer } from './scene/weather.js';
import { WorldRenderer, drawVignette } from './scene/world.js';
import { Toasts } from './toasts.js';
import { TouchControls } from './touch.js';
import '../ui.css';
import './game.css';

/** The face buttons (`input.ts`) as the move-slot keys, in play. */
const PAD_SLOT_KEYS: Record<string, string> = {
  PadA: 'Digit1',
  PadB: 'Digit2',
  PadX: 'Digit3',
  PadY: 'Digit4',
};

export interface MountGameOptions {
  /** The player closed the results, or left the run; `results` if the run ended. */
  onExit(results?: Results): void;
  /** Multiplayer: the pause menu's "Leave the game" (the shell leaves the room). */
  onLeave?(): void | Promise<void>;
  /**
   * Multiplayer: the socket, for notices (owner changed, server updating) and reconnects. The
   * shell doesn't show the `GAME_NOTICES` itself while the game has it.
   */
  client?: GameClient;
  /** The player's save (`GET /api/save`), for achievement notices; fetched if not given. */
  save?: AchievementSave | null;
  /**
   * Opens the full settings screen over the game (the pause menu's "Settings"); without it there's
   * no button. `onClose` is called when the player closes them; the returned function closes them
   * from the game's side (Esc, the run ended) without calling `onClose`.
   */
  openSettings?(onClose: () => void): () => void;
}

export type GameClient = Pick<NetClient, 'on' | 'state'> &
  Partial<Pick<NetClient, 'stats'>> & { readonly draining?: boolean };

export interface GameHandle {
  dispose(): void;
}

export function mountGame(
  el: HTMLElement,
  conn: RoomConnection,
  opts: MountGameOptions,
): GameHandle {
  const screen = new GameScreen(el, conn, opts);
  return { dispose: () => screen.dispose() };
}

class GameScreen {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly layer: HTMLElement;
  private readonly toasts: Toasts;
  private readonly offs: (() => void)[] = [];
  private disposed = false;
  private raf = 0;
  private run: Run | null = null;
  private loadingEl: HTMLElement | null = null;
  private save: AchievementSave | null = null;
  private exited = false;
  /** The network stats (co-op; frame times only in solo). */
  readonly netStats: NetStatsPanel;
  private lastTs = 0;

  constructor(
    host: HTMLElement,
    private readonly conn: RoomConnection,
    private readonly opts: MountGameOptions,
  ) {
    this.canvas = el('canvas', { class: 'ps-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.layer = el('div', { class: 'ps-layer' });
    this.root = el('div', { class: 'ps-game', data: { testid: 'game' } }, this.canvas, this.layer);
    host.append(this.root);
    installInputDevice();
    installMenuNav();
    installUiScale();
    // The gamepad plays (or picks choices, `input.ts`); the pause menu and the results push their
    // own menu scopes over this.
    this.offs.push(menuNav.push({ root: this.root, block: true }));
    this.toasts = new Toasts(this.root);
    this.netStats = new NetStatsPanel(this.layer, conn, opts.client ?? null);
    this.offs.push(() => this.netStats.dispose());
    // For end-to-end tests: the connection's phase (loading / running / ended), hidden.
    const phase = el('span', { class: 'hidden', data: { testid: 'game-phase' } }, conn.phase);
    this.root.append(phase);
    this.offs.push(conn.on('phase', (p) => (phase.textContent = p)));
    this.save = opts.save ?? null;
    if (opts.save === undefined) void this.fetchSave();

    this.offs.push(
      conn.on('loading', ({ game }) => void this.load(game)),
      conn.on('start', ({ game, resumed }) => this.start(game, resumed)),
      conn.on('results', (r) => this.results(r)),
      conn.on('phase', (p) => {
        // Dropped from the game (or it ended) without results: back to the shell.
        if (p === 'ended')
          setTimeout(() => {
            if (!this.run?.results && !this.exited) this.exit(undefined);
          }, 3000);
      }),
    );
    if (opts.client) this.watchClient(opts.client);
    if (conn.phase === 'running' && conn.game) this.start(conn.game, true);
    else if (conn.game) void this.load(conn.game);
    else this.showLoading(0);
    this.raf = requestAnimationFrame((ts) => this.frame(ts));
  }

  private async fetchSave(): Promise<void> {
    try {
      const res = await fetch('/api/save', { credentials: 'same-origin' });
      if (res.ok) this.save = (await res.json()) as AchievementSave;
    } catch {
      // Offline: no achievement notices this run.
    }
  }

  private watchClient(client: GameClient): void {
    // Already updating or reconnecting when the game opened (the shell hides its own notices here).
    if (client.draining) this.toasts.set('draining', t('game.noticeDraining'), 'warn');
    if (client.state === 'reconnecting')
      this.toasts.set('connection', t('game.reconnecting'), 'warn');
    this.offs.push(
      client.on('notice', (n) => {
        const key = NOTICE_TEXT[n.code];
        if (!key) return;
        const text = t(key, { 0: n.usernames?.join(', ') ?? '' });
        if (n.code === 'server-draining') this.toasts.set('draining', text, 'warn');
        else this.toasts.show(text, 'info', 4.5);
      }),
      client.on('state', (s) => {
        if (s === 'reconnecting') this.toasts.set('connection', t('game.reconnecting'), 'warn');
        else if (s === 'open') {
          this.toasts.clear('connection');
          // A new server instance after a deploy isn't draining.
          if (!client.draining) this.toasts.clear('draining');
        } else if (s === 'failed' || s === 'closed')
          this.toasts.set('connection', t('game.connectionLost'), 'warn');
      }),
    );
  }

  // ---------------------------------------------------------------- loading

  private showLoading(frac: number): void {
    if (!this.loadingEl) {
      this.loadingEl = el(
        'div',
        { class: 'ps-screen ps-loading', data: { testid: 'game-loading' } },
        el(
          'div',
          { class: 'ps-box' },
          el('h2', null, t('game.loading')),
          el('div', { class: 'progress' }, el('i')),
        ),
      );
      this.layer.append(this.loadingEl);
    }
    const bar = this.loadingEl.querySelector('i');
    if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
  }

  private hideLoading(): void {
    this.loadingEl?.remove();
    this.loadingEl = null;
  }

  private loadingGame: string | null = null;

  /** Preloads the run's Pokémon, then tells the server we're ready. */
  private async load(game: Game): Promise<void> {
    if (this.loadingGame === game.gameId || this.conn.phase !== 'loading') return;
    this.loadingGame = game.gameId;
    this.showLoading(0);
    // The players, the bosses and the first tiers; later tiers load during the run.
    const list: { dex: number; shiny?: boolean }[] = [
      ...game.players.map((p) => ({ dex: p.dex, shiny: p.shiny })),
      ...game.roster.bosses.map((b) => ({ dex: b.dex })),
      ...game.roster.tiers.slice(0, 2).flatMap((tier) => tier.list.map((e) => ({ dex: e.dex }))),
    ];
    const seen = new Set<string>();
    const unique = list.filter((x) => {
      const k = `${x.dex}/${x.shiny ? 1 : 0}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    try {
      await preloadSprites(
        unique,
        (done, total) => this.showLoading(total ? done / total : 1),
        9000,
      );
    } catch (err) {
      console.error('[game] preload failed:', err);
    }
    if (this.disposed) return;
    if (this.conn.phase === 'loading' && this.conn.game?.gameId === game.gameId) this.conn.loaded();
  }

  // ---------------------------------------------------------------- the run

  private start(game: Game, resumed: boolean): void {
    if (this.disposed) return;
    this.hideLoading();
    if (this.run && this.run.game.gameId === game.gameId) {
      this.run.resumed();
      return;
    }
    this.run?.dispose();
    this.run = new Run(this, game, this.conn, this.canvas, this.layer, this.toasts, this.save);
    if (resumed) this.run.resumed();
  }

  private results(r: Results): void {
    if (!this.run) {
      this.showResults(r, null);
      return;
    }
    this.run.results = r;
    this.run.stop();
    // Let the last faint play out before the screen.
    setTimeout(() => this.showResults(r, this.run), 900);
  }

  private showResults(r: Results, run: Run | null): void {
    if (this.disposed) return;
    this.hideLoading();
    run?.closeOverlays();
    const view = renderResults(r, {
      selfId: this.conn.selfId,
      dead: r.reason === 'all-down',
      bestTimeS: this.save?.stats.bestTimeS ?? null,
      ownedShiny: (dex) => (this.save ? this.save.shiny[String(dex)] !== undefined : null),
      onBack: () => this.exit(r),
    });
    this.layer.append(view);
    this.offs.push(menuNav.push({ root: view }));
  }

  /** Does the shell have a settings screen to open (see `MountGameOptions.openSettings`)? */
  get hasSettings(): boolean {
    return !!this.opts.openSettings;
  }

  /** Opens it; returns the function that closes it. */
  openSettings(onClose: () => void): (() => void) | null {
    return this.opts.openSettings?.(onClose) ?? null;
  }

  exit(results: Results | undefined): void {
    if (this.exited) return;
    this.exited = true;
    this.opts.onExit(results);
  }

  /** "Leave the game" / "Quit run" from the pause menu. */
  async leave(): Promise<void> {
    if (this.conn.quit) {
      // Solo: the run ends and is reported; the results screen follows.
      this.conn.setPaused?.(false);
      this.conn.quit();
      return;
    }
    try {
      await this.opts.onLeave?.();
    } finally {
      this.exit(undefined);
    }
  }

  private frame(ts: number): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame((t2) => this.frame(t2));
    try {
      const t0 = performance.now();
      this.resize();
      if (this.run) this.run.frame(ts, this.ctx);
      else this.clear();
      this.netStats.frame(this.lastTs ? ts - this.lastTs : 0, !!this.run && !this.run.results);
      this.lastTs = ts;
      if (import.meta.env.DEV) devFrameStats(performance.now() - t0);
    } catch (err) {
      // A frame that throws must not freeze the game: log and keep going.
      console.error('[game] frame failed:', err);
    }
  }

  private clear(): void {
    const { width, height } = this.canvas;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = '#0b1020';
    this.ctx.fillRect(0, 0, width, height);
  }

  /** CSS size and the internal resolution (at most ×1.5: pixel art doesn't need more). */
  size = { w: 0, h: 0, dpr: 1 };
  private resize(): void {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (w === this.size.w && h === this.size.h && dpr === this.size.dpr) return;
    this.size = { w, h, dpr };
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const off of this.offs) off();
    this.run?.dispose();
    (this.conn as { close?: () => void }).close?.();
    this.root.remove();
    audio.music(null);
  }
}

/**
 * Dev builds: the main-thread cost of each frame (update + draw), for perf tests:
 * `window.__psFrames = { n, mean, max, p95 }` over the last 600 frames.
 */
const frameTimes: number[] = [];
function devFrameStats(ms: number): void {
  frameTimes.push(ms);
  if (frameTimes.length > 600) frameTimes.shift();
  const sorted = [...frameTimes].sort((a, b) => a - b);
  (window as unknown as { __psFrames: object }).__psFrames = {
    n: frameTimes.length,
    mean: frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length,
    max: sorted[sorted.length - 1],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

/** One run on screen. */
class Run {
  results: Results | null = null;
  private readonly fx = new FX();
  private readonly camera = new Camera();
  private readonly world: WorldRenderer;
  private readonly entities: EntityLayer;
  private readonly weather = new WeatherLayer();
  private readonly hud = new Hud();
  private readonly effects: EventEffects;
  private readonly mates: MateAlerts;
  private readonly predictor: Predictor;
  private readonly choices: ChoiceState;
  private readonly overlay: ChoiceOverlay;
  private readonly input: Input;
  private readonly touch: TouchControls;
  private readonly aim = new AimTracker();
  private readonly mouseFire: MouseFire;
  /** The system cursor is hidden over the game (the crosshair replaces it). */
  private cursorHidden = false;
  private readonly tracker: AchievementTracker | null;
  private readonly offs: (() => void)[] = [];
  private queue: { tick: number; events: SimEvent[] }[] = [];
  private stopInput: (() => void) | null = null;
  private pendingSlot: number | null = null;
  private last = 0;
  private time = 0;
  private flashT = 0;
  private flashDur = 1;
  private flashCol = '#fff';
  private glowT = 0;
  private glowDur = 1;
  private glowCol = '#fff';
  private readonly pause: PauseFlow;
  private pauseEl: HTMLElement | null = null;
  private popPauseNav: (() => void) | null = null;
  private choiceOpen = false;
  private closeSettings: (() => void) | null = null;
  private rotateEl: HTMLElement | null = null;
  private portrait = false;
  private fps = 60;
  private fpsAcc = 0;
  private fpsN = 0;
  private started = false;
  private lastSelf: { x: number; y: number } | null = null;
  private connected = new Map<string, boolean>();
  private stopped = false;

  constructor(
    private readonly screen: GameScreen,
    readonly game: Game,
    private readonly conn: RoomConnection,
    private readonly canvas: HTMLCanvasElement,
    private readonly layer: HTMLElement,
    private readonly toasts: Toasts,
    save: AchievementSave | null,
  ) {
    this.world = new WorldRenderer(game.seed);
    this.entities = new EntityLayer(this.fx, this.camera);
    this.effects = new EventEffects({
      fx: this.fx,
      camera: this.camera,
      entities: this.entities,
      world: this.world,
      say: (text, s) => this.hud.say(text, s),
      flash: (c, s) => this.flash(c, s),
      glow: (c, s) => this.glow(c, s),
      owns: (dex) => (save ? save.owned[String(dex)] !== undefined : null),
    });
    const banner = new MateBanner(toasts.root.parentElement ?? layer);
    this.offs.push(() => banner.dispose());
    this.mates = new MateAlerts({
      banner: (text, hint, self) => banner.show(text, hint, undefined, self),
      toast: (text) => toasts.show(text, 'good', 2.5),
      sfx: (name) => audio.sfx(name),
      now: () => performance.now(),
      pokemonName,
    });
    // Our Pokémon's collision radius and types, as the sim derives them (bodies.json, pokedex).
    const dex = game.players.find((p) => p.id === conn.selfId)?.dex ?? 25;
    const data = loadGameData();
    this.predictor = new Predictor(
      this.world.view,
      data.bodyByDex.get(dex)?.radius ?? 12,
      data.pokemonByDex.get(dex)?.types ?? [],
    );
    this.predictor.onCorrection = (units) => screen.netStats.correction(units);
    const name = (id: string) => game.players.find((p) => p.id === id)?.username ?? id;
    this.choices = new ChoiceState(conn.selfId, game.tickHz, name, (i) => conn.intent(i));
    this.overlay = new ChoiceOverlay(layer, this.choices);
    this.overlay.setMoveInfo((id) => {
      const m = this.conn.latest?.details[this.conn.selfId]?.moves.find((x) => x.id === id);
      return m ? { level: m.level, type: m.type } : null;
    });
    this.input = new Input((code) => this.key(code));
    this.touch = new TouchControls(
      canvas,
      () => this.canMove(),
      () => this.aim.manual,
    );
    // The mouse aims (manual aim): where it is over the game.
    const mouse = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const r = canvas.getBoundingClientRect();
      this.aim.mouseMove(e.clientX - r.left, e.clientY - r.top);
    };
    const leave = () => this.aim.mouseLeave();
    canvas.addEventListener('pointermove', mouse);
    canvas.addEventListener('pointerleave', leave);
    this.offs.push(
      () => canvas.removeEventListener('pointermove', mouse),
      () => canvas.removeEventListener('pointerleave', leave),
    );
    // Fire held: the left button over the game (not on a HUD button).
    this.mouseFire = new MouseFire(canvas, window, (x, y) => this.touch.hitsButton(x, y));
    this.offs.push(() => this.mouseFire.dispose());
    this.tracker = save ? new AchievementTracker(save, conn.selfId) : null;
    this.offs.push(conn.on('snapshot', (s) => this.onSnapshot(s)));
    this.pause = new PauseFlow({
      solo: this.isSolo(),
      setPaused: (p) => this.setPaused(p),
      render: (view, prev) => this.renderPause(view, prev),
    });
    const vis = () => {
      if (!document.hidden || this.results || this.stopped) return;
      this.touch.reset();
      this.pause.autoPause();
    };
    document.addEventListener('visibilitychange', vis);
    this.offs.push(() => document.removeEventListener('visibilitychange', vis));
    this.startInput();
  }

  private isSolo(): boolean {
    return typeof this.conn.setPaused === 'function';
  }

  /** A full snapshot follows a resume: forget the old history. */
  resumed(): void {
    this.predictor.reset();
    this.queue = [];
    this.started = false;
    this.startInput();
  }

  private startInput(): void {
    this.stopInput?.();
    this.stopInput = this.conn.startInputLoop(() => {
      const [x, y] = this.canMove() ? this.input.axis(this.touch.vector()) : [0, 0];
      const slot = this.pendingSlot;
      this.pendingSlot = null;
      return { moveX: x, moveY: y, slot, aim: this.aim.input(), fire: this.firing() };
    });
  }

  /** Fire held (manual aim): the mouse button over the game or the gamepad's right trigger. */
  private firing(): boolean {
    return this.aim.manual && this.canMove() && (this.mouseFire.held || this.input.fireHeld());
  }

  /** The run ended: stop sending input. */
  stop(): void {
    this.stopped = true;
    this.stopInput?.();
    this.stopInput = null;
  }

  private canMove(): boolean {
    return (
      !this.stopped &&
      !this.overlay.isOpen &&
      this.pause.view === 'playing' &&
      !this.portrait &&
      this.conn.phase === 'running'
    );
  }

  private onSnapshot(s: Snapshot): void {
    if (s.events.length) this.queue.push({ tick: s.tick, events: s.events });
    // Teammates going offline and coming back (the sim marks them; the server holds their slot).
    for (const p of s.players) {
      if (p.id === this.conn.selfId) continue;
      const was = this.connected.get(p.id);
      const now = p.connected && !p.left;
      if (was !== undefined && was !== now && !p.left) {
        const name = this.game.players.find((x) => x.id === p.id)?.username ?? p.id;
        this.toasts.show(
          t(now ? 'game.playerReconnected' : 'game.playerDisconnected', { 0: name }),
          now ? 'good' : 'warn',
        );
      }
      if (p.left && was !== undefined && !this.connected.has(`${p.id}/left`)) {
        this.connected.set(`${p.id}/left`, true);
        const name = this.game.players.find((x) => x.id === p.id)?.username ?? p.id;
        this.toasts.show(t('hud.leftTheGame', { 0: name }), 'info');
      }
      this.connected.set(p.id, now);
    }
  }

  private key(code: string): boolean {
    if (this.results || this.stopped) return false;
    if (this.pause.view === 'settings') {
      // Esc is the settings' back button; the rest is for the settings, not the game.
      if (code !== 'Escape') return false;
      this.pause.toggle();
      return true;
    }
    if (this.overlay.key(code)) return true;
    // A/B/X/Y are move slots 1–4 outside a choice.
    code = PAD_SLOT_KEYS[code] ?? code;
    if (code === 'Escape' || code === 'KeyP') {
      this.togglePause();
      return true;
    }
    if (this.pause.view !== 'playing') return false;
    if (aimKey(code)) return true;
    const digit = /^(?:Digit|Numpad)([1-4])$/.exec(code);
    if (digit) {
      this.setSlot(Number(digit[1]) - 1);
      return true;
    }
    if (code === 'KeyQ' || code === 'KeyE' || code === 'Tab') {
      void this.conn.intent({ type: 'cycleSlot', dir: code === 'KeyQ' ? -1 : 1 });
      return true;
    }
    return false;
  }

  private setSlot(i: number): void {
    const latest = this.conn.latest;
    const self = latest?.players.find((p) => p.id === this.conn.selfId);
    const detail = latest?.details[this.conn.selfId];
    if (!self || !detail || i >= detail.slots.length || self.active === i) return;
    this.pendingSlot = i;
  }

  // ---------------------------------------------------------------- pause

  togglePause(): void {
    if (this.results) return;
    this.pause.toggle();
  }

  /** Solo: the worker's sim waits while paused. */
  private setPaused(p: boolean): void {
    this.conn.setPaused?.(p);
    if (p) {
      // Inputs aren't acked while the worker waits: stop sending them.
      this.stopInput?.();
      this.stopInput = null;
    } else if (!this.stopped) this.startInput();
  }

  private renderPause(view: PauseView, prev: PauseView): void {
    if (prev === 'menu') {
      this.pauseEl?.remove();
      this.pauseEl = null;
      this.popPauseNav?.();
      this.popPauseNav = null;
    } else if (prev === 'settings') {
      this.closeSettings?.();
      this.closeSettings = null;
    }
    if (view === 'menu') {
      if (prev === 'playing') audio.sfx('pause');
      this.touch.reset();
      this.pauseEl = this.pauseMenu();
      this.layer.append(this.pauseEl);
      this.popPauseNav = menuNav.push({ root: this.pauseEl, back: () => this.pause.resume() });
    } else if (view === 'settings') {
      this.touch.reset();
      this.closeSettings = this.screen.openSettings(() => this.pause.closeSettings());
    }
  }

  private pauseMenu(): HTMLElement {
    const solo = this.isSolo();
    const s = settings.get();
    const slider = (label: string, key: 'musicVolume' | 'sfxVolume') => {
      const input = el('input', { type: 'range' });
      input.min = '0';
      input.max = '1';
      input.step = '0.05';
      input.value = String(s[key]);
      input.addEventListener('input', () => settings.set({ [key]: Number(input.value) }));
      return el('label', { class: 'ps-slider' }, el('span', null, label), input);
    };
    const mute = el('input', { type: 'checkbox' });
    mute.checked = s.muted;
    mute.addEventListener('change', () => settings.set({ muted: mute.checked }));
    return el(
      'div',
      { class: 'ps-screen', data: { testid: 'pause' } },
      el(
        'div',
        { class: 'ps-box ps-pause' },
        el('h2', null, t('pause.pause')),
        el(
          'p',
          { class: 'sub' },
          el('span', { class: 'kb-only' }, controlsHint(this.touch.active, settings.get().aimMode)),
          el('span', { class: 'pad-only' }, glyphText(controlsHint(false, 'auto', true))),
        ),
        solo ? null : el('p', { class: 'note' }, t('pause.groupGameTheGameKeeps')),
        el(
          'div',
          { class: 'ps-sound' },
          slider(t('game.music'), 'musicVolume'),
          slider(t('game.sounds'), 'sfxVolume'),
          el('label', { class: 'ps-check' }, mute, ` ${t('game.mute')}`),
        ),
        el(
          'div',
          { class: 'row' },
          el(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              data: { testid: 'resume' },
              on: { click: () => this.pause.resume() },
            },
            t('pause.continue'),
            ' ',
            inputHint(['Esc'], ['b']),
          ),
          this.screen.hasSettings
            ? el(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  data: { testid: 'pause-settings' },
                  on: { click: () => this.pause.openSettings() },
                },
                t('menu.settings'),
              )
            : null,
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              data: { testid: 'game-exit', back: '' },
              on: {
                click: () => {
                  this.pause.resume();
                  void this.screen.leave();
                },
              },
            },
            solo ? t('pause.quitRun') : t('pause.leaveTheGame'),
          ),
        ),
      ),
    );
  }

  /** Phones upright: "rotate your phone" over the game, and solo runs pause (original implementation). */
  private checkOrientation(w: number, h: number): void {
    const portrait = this.touch.active && h > w && !this.results;
    if (portrait === this.portrait) return;
    this.portrait = portrait;
    if (portrait) {
      this.touch.reset();
      this.pause.autoPause();
      this.rotateEl ??= el(
        'div',
        { class: 'ps-screen ps-rotate', data: { testid: 'rotate' } },
        el(
          'div',
          { class: 'ps-box' },
          el('div', { class: 'ps-rotate-ico' }, icon('phone', 48)),
          el('h2', null, t('settings.rotateYourPhone')),
          el('p', { class: 'sub' }, t('settings.pokesurvivorIsPlayedInLandscape')),
        ),
      );
      this.layer.append(this.rotateEl);
    } else this.rotateEl?.remove();
  }

  closeOverlays(): void {
    this.pause.close();
    this.rotateEl?.remove();
    this.portrait = false;
    this.overlay.root.classList.add('hidden');
    clear(this.overlay.root);
  }

  private flash(color: string, seconds: number): void {
    this.flashCol = color;
    this.flashDur = seconds;
    this.flashT = seconds;
  }

  private glow(color: string, seconds: number): void {
    this.glowCol = color;
    this.glowDur = seconds;
    this.glowT = seconds;
  }

  // ---------------------------------------------------------------- per frame

  frame(ts: number, ctx: CanvasRenderingContext2D): void {
    const real = this.last ? (ts - this.last) / 1000 : 0;
    this.last = ts;
    const dt = Math.min(1 / 20, Math.max(0, real));
    this.time += dt;
    if (!this.stopped) sampleFrame(real);
    this.fpsAcc += real;
    this.fpsN++;
    if (this.fpsAcc >= 0.5) {
      this.fps = Math.round(this.fpsN / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    this.input.poll();
    const conn = this.conn;
    const now = conn.now?.() ?? Date.now();
    const sample = conn.buffer.sample(now);
    const latest = conn.latest;
    const { w, h, dpr } = this.screen.size;
    this.camera.resize(w, h, dpr);
    this.checkOrientation(w, h);
    if (!sample || !latest) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    // The world as of the newest snapshot (props broken, arena, biome).
    this.world.sync(latest.team.biome, latest.misc.arena, latest.world, !this.started);
    // Our own Pokémon: predicted.
    const serverSelf = latest.players.find((p) => p.id === conn.selfId) ?? null;
    let selfPos: SelfView | null = null;
    if (serverSelf) {
      const active =
        !latest.paused &&
        !latest.ended &&
        !serverSelf.dead &&
        serverSelf.connected &&
        !this.pause.isPaused &&
        !this.stopped;
      this.predictor.update({
        server: serverSelf,
        ackSeq: conn.ackedInputSeq,
        ackedInput: conn.ackedInput,
        tick: latest.tick,
        unacked: conn.unackedInputs(),
        speed: latest.self?.speed ?? 0,
        now,
        active,
      });
      selfPos = {
        x: this.predictor.x,
        y: this.predictor.y,
        walking: active && this.predictor.walking,
        moveAngle: this.predictor.moveAngle,
      };
      // Manual aim: from the mouse or a stick, relative to where we draw our Pokémon.
      if (this.canMove())
        this.aim.update(
          this.touch.aimVector() ?? this.input.aimAxis(),
          this.camera.toScreen(selfPos.x, selfPos.y),
          serverSelf.aim,
        );
      const sent = this.aim.input();
      if (sent !== null) selfPos.aim = sent;
    }
    const frame = buildFrame(this.game, conn.selfId, sample, latest, this.time, dt, selfPos);
    this.effects.trackFields(frame);
    // Events play as the interpolated view reaches their snapshot.
    while (this.queue[0] && this.queue[0].tick <= sample.to.tick) {
      const q = this.queue.shift()!;
      for (const e of q.events) {
        if (e.type === 'cast' && e.playerId === conn.selfId) this.hud.onCast(e.moveId, this.time);
        this.tracker?.event(e);
      }
      this.effects.play(q.events, frame);
      this.mates.play(q.events, frame);
    }
    if (this.queue.length > 60) this.queue.splice(0, this.queue.length - 60);

    this.entities.update(frame);
    this.entities.trackShots(frame, (x, y) => this.world.terrainAt(x, y) === 'wall');
    this.world.update(dt);
    this.fx.update(dt);
    this.weather.update(latest.misc.weather, dt);
    const focus = frame.self ?? frame.players.find((p) => !p.left) ?? null;
    if (focus) {
      const jump = this.lastSelf
        ? Math.hypot(focus.x - this.lastSelf.x, focus.y - this.lastSelf.y)
        : Infinity;
      if (!this.started || jump > 400) this.camera.snapTo(focus.x, focus.y);
      else this.camera.follow(focus.x, focus.y, dt);
      this.lastSelf = { x: focus.x, y: focus.y };
    }
    this.started = true;

    // Choices: derived from the newest snapshot every frame.
    this.choices.sync({
      tick: latest.tick,
      choices: latest.choices,
      waiting: latest.waiting,
      rerollsLeft: frame.selfDetail?.rerollsLeft ?? 0,
    });
    this.overlay.update();
    // A choice opened under a held d-pad or stick: it doesn't move the highlight until let go.
    if (this.overlay.isOpen && !this.choiceOpen) this.input.latchNav();
    this.choiceOpen = this.overlay.isOpen;

    // Achievement notices.
    if (this.tracker) {
      this.tracker.observe(latest.team, latest.time);
      for (const a of this.tracker.check())
        this.toasts.show(t('profile.achievement', { 0: a.name }), 'achievement', 4.5, 'trophy');
    }

    // Music: the rift, a boss, or the biome's.
    audio.music(
      latest.ended
        ? null
        : latest.misc.arena
          ? 'rift'
          : frame.enemies.some((e) => e.boss && !e.dead)
            ? 'boss'
            : biomeMusic(latest.team.biome),
    );

    this.draw(ctx, frame, w, h, dpr);
    if (import.meta.env.DEV)
      (window as unknown as { __psCounts: object }).__psCounts = {
        enemies: frame.enemies.length,
        projectiles: frame.projectiles.length,
        pickups: frame.pickups.length,
        fx: this.fx.count,
        time: latest.time,
        // Aim (e2e): what we send (null: auto), the server's aim for us, our Pokémon on screen.
        aim: this.aim.input(),
        fire: this.firing(),
        serverAim: latest.players.find((p) => p.id === this.conn.selfId)?.aim ?? null,
        self: frame.self ? this.camera.toScreen(frame.self.x, frame.self.y) : null,
      };
  }

  private draw(ctx: CanvasRenderingContext2D, frame: Frame, w: number, h: number, dpr: number) {
    const cam = this.camera;
    const now = frame.time;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.scale(cam.scale, cam.scale);
    cam.apply(ctx);
    this.world.drawGround(ctx, cam);
    this.world.drawLiquid(ctx, cam, now);
    this.entities.drawGround(ctx, frame);
    this.entities.drawPickups(ctx, frame.pickups, now);
    // Everything with feet is sorted by Y: props, enemies, players, the rift, the lost Pokémon.
    const items: { y: number; draw: (c: CanvasRenderingContext2D) => void }[] = [];
    for (const p of this.world.visibleProps(cam))
      items.push({
        y: p.flat ? p.y - 4000 : p.y,
        draw: (c) => this.world.drawProp(c, p, now, this.fx),
      });
    items.push(...this.entities.drawables(frame));
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw(ctx);
    // Manual aim: where our attacks go, around our Pokémon.
    const me = frame.self;
    if (this.aim.manual && me && !me.dead && !this.results)
      drawAimIndicator(ctx, me.x, me.y, me.aim, now, LIFT);
    this.entities.drawProjectiles(ctx, frame);
    this.entities.drawAirFields(ctx, frame.fields, now);
    this.fx.draw(ctx, now);
    ctx.restore();

    this.weather.draw(ctx, w, h, frame.dt);
    drawVignette(ctx, w, h);
    const fog = this.weather.fog;
    if (fog > 0) {
      // Fog: the vignette closes in a little (without covering the middle).
      const g = ctx.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.32,
        w / 2,
        h / 2,
        Math.max(w, h) * 0.62,
      );
      g.addColorStop(0, 'rgba(200,205,220,0)');
      g.addColorStop(1, `rgba(200,205,220,${0.45 * fog})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (!this.results) {
      const choosing = new Set(frame.snap.waiting.map((c) => c.playerId));
      this.hud.draw(ctx, {
        frame,
        w,
        h,
        scale: hudScale(w, h, settings.get().hudSize),
        camera: cam,
        weather: this.weather,
        touch: this.touch,
        choosing,
        biomeName: this.world.biomeName,
        fps: settings.get().showFps ? this.fps : null,
        setSlot: (i) => this.setSlot(i),
        togglePause: () => this.togglePause(),
        canAct: this.canMove(),
        aimMode: settings.get().aimMode,
        toggleAim: () => toggleAimMode(),
        pad: inputDevice.device === 'gamepad' ? inputDevice.layout : null,
        showStats: settings.get().showStats,
      });
      this.touch.draw(ctx);
      this.screen.netStats.placeBelow(this.hud.topLeftBottom);
    }
    if (this.glowT > 0) {
      this.glowT -= frame.dt;
      ctx.save();
      // Clear in the middle, the colour at the edges; fading out. Calm mode softens it like the flash.
      ctx.globalAlpha =
        Math.max(0, Math.min(1, (this.glowT / this.glowDur) * 1.6)) *
        (settings.get().calmMode ? 0.4 : 0.85);
      const r = Math.hypot(w, h) / 2;
      const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.45, w / 2, h / 2, r);
      g.addColorStop(0, 'rgba(0, 0, 0, 0)');
      g.addColorStop(1, this.glowCol);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
    if (this.flashT > 0) {
      this.flashT -= frame.dt;
      ctx.save();
      // "Calm mode": the full-screen flash is a third as strong.
      ctx.globalAlpha =
        Math.min(1, (this.flashT / this.flashDur) * 1.4) * (settings.get().calmMode ? 0.3 : 1);
      ctx.fillStyle = this.flashCol;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
    this.drawCursor(ctx);
  }

  /**
   * Manual aim with a mouse: a crosshair instead of the system cursor over the game. The cursor
   * comes back on HUD buttons, in menus, choices and pause, in auto mode and on touch devices.
   */
  private drawCursor(ctx: CanvasRenderingContext2D): void {
    const at = this.aim.pointer;
    let show = !!at && this.aim.manual && !this.touch.active && this.canMove() && !this.results;
    if (show && at) {
      const r = this.canvas.getBoundingClientRect();
      show = !this.touch.hitsButton(r.left + at[0], r.top + at[1]);
    }
    if (show !== this.cursorHidden) {
      this.cursorHidden = show;
      this.canvas.style.cursor = show ? 'none' : '';
    }
    if (show && at) {
      const s = settings.get();
      drawCrosshair(ctx, at[0], at[1], CROSSHAIR_COLORS[s.crosshairColor], s.crosshairScale);
    }
  }

  dispose(): void {
    this.stop();
    this.popPauseNav?.();
    this.closeSettings?.();
    this.closeSettings = null;
    for (const off of this.offs) off();
    this.input.dispose();
    this.touch.dispose();
    this.overlay.root.remove();
  }
}
