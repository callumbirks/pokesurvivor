// The gacha's pixel-art slot machine (port of legacy ui/slots.js). Drawn whole on a canvas at art
// resolution (176×170) and scaled up without smoothing, like the rest of the game.
//
//   lever → the 3 reels spin → they stop one by one on the symbol of the rarity that came out
//   (Poké, Great, Ultra, Luxury and Master Ball, as in RARITY_BALL; the red star is a shiny).
//   For an epic, legendary or shiny, the last reel takes its time and the lights go wild.
//   A ×10 is 10 quick pulls; each prize drops into the tray as a ball.
//
// A click speeds it up. The results come from the server: this only animates them.
import { t } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import { drawIcon } from '../icons.js';
import { RARITY_BALL } from './dom.js';

export interface SlotResult {
  rarity: number;
  shiny: boolean;
}

export interface SlotStyle {
  /** The rarity's colour and display name (from the server's gacha rules). */
  color(rarity: number): string;
  name(rarity: number): string;
}

const W = 176;
const H = 170;
const CELL = 30;
const STRIP = [
  'ball',
  'ball2',
  'ball',
  'ball3',
  'ball',
  'ball2',
  'ballLux',
  'ball',
  'ball4',
  'ball2',
  'ball3',
  'shiny',
  'ball',
  'ball2',
];
const REEL_X = [26, 65, 104] as const;
const REEL_W = 36;
const REEL_Y = 44;
const REEL_H = 46;
const MID = REEL_Y + REEL_H / 2;
const SHINY_COLOR = '#9ae6ff';
const C = {
  body: '#c8323c',
  bodyD: '#8e1f2a',
  bodyL: '#ef6464',
  trim: '#ffd23f',
  trimD: '#c08a10',
  dark: '#1b1528',
  glass: '#0d1230',
  reel: '#f4efe2',
  reelD: '#c9c1ad',
  chrome: '#c9d2de',
  chromeD: '#7d8899',
  led: '#2a0f14',
  bulbOn: '#ffe9a0',
  bulbOff: '#6b4a20',
};

interface Reel {
  off: number;
  spin: boolean;
  sym: string;
  bounce: number;
  speed: number;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
  col: string;
}
interface State {
  t: number;
  lever: number;
  reels: Reel[];
  ten: boolean;
  tray: { sym: string; y: number; vy: number; done: boolean }[];
  led: string;
  ledCol: string;
  win: { col: string; t: number } | null;
  frenzy: number;
  sparks: Spark[];
}

export const SLOT_SIZE = { width: W, height: H };

export class SlotMachine {
  private readonly ctx: CanvasRenderingContext2D;
  private st: State | null = null;
  private raf = 0;
  private last = 0;
  /** A click speeds everything up. */
  private fast = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly style: SlotStyle,
  ) {
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  /** Speeds up the rest of the animation (a click on the machine). */
  hurry(): void {
    this.fast = true;
  }

  private symOf(r: SlotResult): string {
    return r.shiny ? 'shiny' : (RARITY_BALL[r.rarity] ?? 'ball');
  }

  private colOf(r: SlotResult): string {
    return r.shiny ? SHINY_COLOR : this.style.color(r.rarity);
  }

  /** Animates the pulls; resolves when it's done. */
  async play(results: readonly SlotResult[]): Promise<void> {
    const ten = results.length > 1;
    this.fast = false;
    const st: State = {
      t: 0,
      lever: 0,
      reels: REEL_X.map(() => ({
        off: Math.random() * 400,
        spin: false,
        sym: 'ball',
        bounce: 0,
        speed: 0,
      })),
      ten,
      tray: [],
      led: ten ? t('gacha.pullX10') : t('gacha.goodLuck'),
      ledCol: C.bulbOn,
      win: null,
      frenzy: 0,
      sparks: [],
    };
    this.st = st;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((now) => this.frame(now));

    for (const [i, r] of results.entries()) {
      if (ten) st.led = t('app.slotsPullOf', { 0: i + 1, 1: results.length });
      // The lever.
      audio.sfx('ball');
      await this.tween((v) => (st.lever = v), 0, 1, ten ? 0.12 : 0.22);
      for (const rl of st.reels) {
        rl.spin = true;
        rl.speed = 520;
      }
      await this.tween((v) => (st.lever = v), 1, 0, ten ? 0.1 : 0.2);
      st.win = null;
      await this.wait(ten ? 0.18 : 0.6);
      const big = r.rarity >= 4 || r.shiny;
      for (let k = 0; k < 3; k++) {
        const reel = st.reels[k];
        if (!reel) continue;
        if (k === 2 && big) {
          // Suspense: the last reel slows down and the lights flash.
          st.frenzy = 1;
          st.led = r.shiny
            ? t('gacha.shiny2')
            : r.rarity === 5
              ? t('gacha.legendary')
              : t('gacha.epic');
          st.ledCol = this.colOf(r);
          await this.tween((v) => (reel.speed = v), 520, 120, ten ? 0.5 : 1.1);
        }
        reel.spin = false;
        reel.sym = this.symOf(r);
        reel.bounce = 1;
        reel.speed = 0;
        audio.sfx('shake');
        await this.wait(ten ? 0.08 : 0.32);
      }
      st.frenzy = 0;
      // The prize.
      st.win = { col: this.colOf(r), t: 0 };
      const name = this.style.name(r.rarity).toUpperCase();
      st.led = r.shiny ? t('app.slotsShiny', { 0: name }) : name;
      st.ledCol = this.colOf(r);
      audio.sfx('reveal', { rarity: r.rarity });
      if (r.rarity === 5) audio.sfx('legend');
      if (r.shiny) audio.sfx('shiny');
      if (big) this.burst(this.colOf(r), r.rarity === 5 || r.shiny ? 60 : 30);
      st.tray.push({ sym: this.symOf(r), y: 104, vy: 0, done: false });
      await this.wait(ten ? (big ? 0.7 : 0.28) : 1.0);
    }
    await this.wait(0.4);
    this.stop();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.st = null;
  }

  private wait(s: number): Promise<void> {
    return new Promise((resolve) => {
      const end = performance.now() + s * 1000 * (this.fast ? 0.25 : 1);
      const check = () => {
        if (performance.now() >= end || !this.st) resolve();
        else setTimeout(check, 16);
      };
      check();
    });
  }

  private tween(set: (v: number) => void, a: number, b: number, dur: number): Promise<void> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const d = dur * 1000 * (this.fast ? 0.25 : 1);
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / d);
        set(a + (b - a) * k);
        if (k < 1 && this.st) requestAnimationFrame(step);
        else resolve();
      };
      step();
    });
  }

  private burst(col: string, n: number): void {
    const st = this.st;
    if (!st) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 30 + Math.random() * 70;
      st.sparks.push({
        x: W / 2,
        y: MID,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 30,
        t: 0,
        life: 0.6 + Math.random() * 0.6,
        col: Math.random() < 0.5 ? col : '#ffffff',
      });
    }
  }

  // ---------------------------------------------------------------- drawing

  private frame(now: number): void {
    const st = this.st;
    if (!st) return;
    const dt = Math.min(0.05, (now - this.last) / 1000) * (this.fast ? 2 : 1);
    this.last = now;
    st.t += dt;
    let tick = false;
    for (const rl of st.reels) {
      if (rl.spin) {
        const before = Math.floor(rl.off / CELL);
        rl.off += rl.speed * dt;
        if (Math.floor(rl.off / CELL) !== before) tick = true;
      }
      if (rl.bounce > 0) rl.bounce = Math.max(0, rl.bounce - dt * 5);
    }
    // The reels tick as symbols go past.
    if (tick && Math.random() < 0.5) audio.sfx('hover');
    if (st.win) st.win.t += dt;
    for (const b of st.tray) {
      if (b.done) continue;
      b.vy += 400 * dt;
      b.y += b.vy * dt;
      if (b.y >= 132) {
        b.y = 132;
        b.vy *= -0.35;
        if (Math.abs(b.vy) < 20) b.done = true;
      }
    }
    for (const p of st.sparks) {
      p.t += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 120 * dt;
    }
    st.sparks = st.sparks.filter((p) => p.t < p.life);
    this.draw(st);
    this.raf = requestAnimationFrame((n) => this.frame(n));
  }

  private rect(x: number, y: number, w: number, h: number, c: string): void {
    this.ctx.fillStyle = c;
    this.ctx.fillRect(x, y, w, h);
  }

  private draw(st: State): void {
    const ctx = this.ctx;
    const R = (x: number, y: number, w: number, h: number, c: string) => this.rect(x, y, w, h, c);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    const time = st.t;

    // Cabinet.
    R(10, 30, 142, 132, C.dark);
    R(11, 31, 140, 130, C.body);
    R(11, 31, 6, 130, C.bodyL);
    R(145, 31, 6, 130, C.bodyD);
    R(11, 155, 140, 6, C.bodyD);
    R(10, 162, 142, 3, C.dark);

    // Sign with light bulbs.
    R(14, 4, 134, 28, C.dark);
    R(15, 5, 132, 26, C.trimD);
    R(18, 8, 126, 20, C.led);
    const winCol = st.win && Math.floor(st.win.t * 8) % 2 === 0 ? st.win.col : null;
    let i = 0;
    for (let x = 16; x < 146; x += 7) {
      this.bulb(st, x, 5, i++, winCol);
      this.bulb(st, x, 29, i++, winCol);
    }
    for (let y = 12; y < 28; y += 7) {
      this.bulb(st, 15, y, i++, winCol);
      this.bulb(st, 146, y, i++, winCol);
    }
    const title = t('app.slotsTitle');
    ctx.font = '700 12px Pixelify, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = C.dark;
    ctx.fillText(title, W / 2 + 1, 23);
    ctx.fillStyle = C.trim;
    ctx.fillText(title, W / 2, 22);

    // Reel window.
    R(20, 38, 122, 58, C.dark);
    R(21, 39, 120, 56, C.trimD);
    R(23, 41, 116, 52, C.glass);
    st.reels.forEach((rl, k) => this.drawReel(rl, REEL_X[k] ?? 0));
    // The win line.
    const lineCol = st.win ? st.win.col : '#ff5f6d';
    R(22, MID - 1, 3, 2, lineCol);
    R(137, MID - 1, 3, 2, lineCol);
    if (st.win && st.win.t < 1.2 && Math.floor(st.win.t * 10) % 2 === 0) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = st.win.col;
      ctx.lineWidth = 2;
      ctx.strokeRect(22, 40, 118, 54);
      ctx.globalAlpha = 1;
    }

    // LED display.
    R(36, 100, 90, 16, C.dark);
    R(37, 101, 88, 14, C.led);
    ctx.font = '700 8px Pixelify, "Segoe UI", sans-serif';
    ctx.fillStyle = st.ledCol || C.bulbOn;
    if (!st.frenzy || Math.floor(time * 10) % 2 === 0) ctx.fillText(st.led, 81, 111);
    // Decorative buttons.
    R(132, 102, 8, 6, C.trim);
    R(132, 108, 8, 2, C.trimD);
    R(22, 102, 8, 6, '#5fe08a');
    R(22, 108, 8, 2, '#2f9a52');

    // Tray.
    R(26, 122, 110, 26, C.dark);
    R(28, 124, 106, 22, '#0a0712');
    R(28, 144, 106, 2, C.chromeD);
    st.tray.forEach((b, j) => {
      const one = !st.ten;
      const x = one ? 81 - 12 : 30 + j * 10;
      drawIcon(ctx, b.sym, x, Math.round(b.y - (one ? 10 : 0)), one ? 24 : 12);
    });

    // Lever.
    R(152, 74, 14, 24, C.dark);
    R(153, 75, 12, 22, C.chrome);
    R(160, 75, 5, 22, C.chromeD);
    const knobY = Math.round(34 + st.lever * 48);
    const top = Math.min(knobY, 82);
    const bot = Math.max(knobY, 82);
    R(157, top, 4, bot - top, C.chromeD);
    R(157, top, 2, bot - top, C.chrome);
    this.disc(159, knobY, 6, C.dark);
    this.disc(159, knobY, 5, '#ff4d4d');
    R(156, knobY - 3, 2, 2, '#ffd0d0');

    // The prize's sparks.
    for (const p of st.sparks) R(Math.round(p.x), Math.round(p.y), 2, 2, p.col);
  }

  private bulb(st: State, x: number, y: number, i: number, winCol: string | null): void {
    const on = st.frenzy ? Math.floor(st.t * 14 + i) % 2 === 0 : Math.floor(st.t * 4 + i) % 3 !== 0;
    this.rect(x, y, 3, 3, winCol ?? (on ? C.bulbOn : C.bulbOff));
  }

  private disc(cx: number, cy: number, r: number, col: string): void {
    this.ctx.fillStyle = col;
    for (let y = -r; y <= r; y++) {
      const w = Math.round(Math.sqrt(r * r - y * y));
      this.ctx.fillRect(cx - w, cy + y, w * 2, 1);
    }
  }

  private drawReel(rl: Reel, x: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, REEL_Y, REEL_W, REEL_H);
    ctx.clip();
    this.rect(x, REEL_Y, REEL_W, REEL_H, C.reel);
    const n = STRIP.length;
    if (rl.spin) {
      const base = rl.off % CELL;
      const i0 = Math.floor(rl.off / CELL);
      for (let k = -2; k <= 2; k++) {
        const name = STRIP[(((i0 - k) % n) + n) % n] ?? 'ball';
        const y = Math.round(MID - 12 + k * CELL + base);
        ctx.globalAlpha = rl.speed > 300 ? 0.75 : 1;
        drawIcon(ctx, name, x + 6, y, 24);
        if (rl.speed > 300) {
          // Motion blur: a faint copy above.
          ctx.globalAlpha = 0.25;
          drawIcon(ctx, name, x + 6, y - 6, 24);
        }
        ctx.globalAlpha = 1;
      }
    } else {
      const by = Math.round(Math.sin(rl.bounce * Math.PI) * 5);
      const at = STRIP.indexOf(rl.sym);
      ctx.globalAlpha = 0.35;
      drawIcon(ctx, STRIP[(at + 3) % n] ?? 'ball', x + 6, MID - 12 - CELL + by, 24);
      drawIcon(ctx, STRIP[(at + 5) % n] ?? 'ball', x + 6, MID - 12 + CELL + by, 24);
      ctx.globalAlpha = 1;
      drawIcon(ctx, rl.sym, x + 6, MID - 12 + by, 24);
    }
    // The reel's curved shading (darker at the top and bottom).
    ctx.globalAlpha = 0.28;
    this.rect(x, REEL_Y, REEL_W, 6, C.reelD);
    this.rect(x, REEL_Y + REEL_H - 6, REEL_W, 6, C.reelD);
    ctx.globalAlpha = 0.18;
    this.rect(x, REEL_Y, REEL_W, 3, '#000');
    this.rect(x, REEL_Y + REEL_H - 3, REEL_W, 3, '#000');
    ctx.globalAlpha = 1;
    ctx.restore();
    this.rect(x - 1, REEL_Y, 1, REEL_H, C.dark);
    this.rect(x + REEL_W, REEL_Y, 1, REEL_H, C.dark);
  }
}
