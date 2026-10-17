// The in-run HUD, drawn in screen coordinates on the game canvas (port of original implementation, the
// HUD half of systems/events.js and the co-op panel): XP bar, HP and level, the clock, weather,
// the boss bars, off-screen arrows (rift, shinies, teammates, the lost Pokémon, thieves, wild
// legendaries), event
// timers, the banner, move slots with cooldowns, the held item, the aim switch, and touch buttons.
import { t } from '@pokesurvivor/data';
import { gameData } from '../live-config.js';
import { REVIVE_SECONDS, momentumCap } from '@pokesurvivor/sim';
import type { AimMode } from '../settings.js';
import { drawGlyph, drawGlyphText, glyphDrawSize, type PadButton } from '../glyphs.js';
import { drawIcon as drawIconAt, typeColor } from '../icons.js';
import type { PadLayout } from '../input-device.js';
import { bodyHeight } from '../sprites.js';
import type { Frame } from './frame.js';
import { PLAYER_COLORS, altarPower, pokemonName } from './scene/entities.js';
import type { WeatherLayer } from './scene/weather.js';
import { weatherKind } from './scene/weather.js';
import type { TouchControls } from './touch.js';
import { drawStatsPanel, visibleStatRows } from './stats-panel.js';
import { itemName, mmss, moveName, typeName } from './text.js';

/** HUD icons: snapped to whole screen pixels under the HUD's scale. */
const drawIcon = (
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
  size: number,
) => drawIconAt(ctx, name, x, y, size, true);
const F = (w: number, s: number) => `${w} ${s}px Pixelify,"Segoe UI",system-ui,sans-serif`;
const BUFF_COLORS = ['#ff6b4d', '#7fe0ff', '#b0b8c8', '#5fe08a'];
const BOND = '#ff8ad8';
/** Wild legendaries: their boss bar and off-screen arrow. */
const WILD_LEGEND = '#b48aff';
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;
/** The menus' charcoal palette (ui.css), for the HUD's Momentum chip. */
const CHARCOAL = {
  bg: '#272223',
  rule: '#4d4240',
  text: '#f2e9d8',
  muted: '#a3968a',
  accent: '#e0603e',
  ink: '#141012',
  gold: '#ffd65c',
};
/** Momentum shows gold from this fraction of the cap; the first-time hint at this many stacks. */
const MOMENTUM_HIGH = 2 / 3;
const MOMENTUM_HINT_STACKS = 5;
const MOMENTUM_HINT_KEY = 'ps.hint.momentum';
/** Has this device shown the hint `key` before? Marks it shown. Per device, like the changelog. */
function seenHint(key: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    if (localStorage.getItem(key)) return true;
    localStorage.setItem(key, '1');
    return false;
  } catch {
    return true;
  }
}
/** The gamepad buttons that pick move slots 1–4. */
const SLOT_PAD: readonly PadButton[] = ['a', 'b', 'x', 'y'];
/** The gamepad controls hint's glyphs (HUD px, before snapping) and its margin to the bottom. */
const PAD_HINT_GLYPH = 24;
const PAD_HINT_BOTTOM = 6;
/**
 * The band the gamepad controls hint takes at the bottom (HUD px): the move slots stay above it
 * while a pad is in use, so they don't move when the hint goes away.
 */
const padHintBand = (ctx: CanvasRenderingContext2D) =>
  glyphDrawSize(ctx, PAD_HINT_GLYPH) + PAD_HINT_BOTTOM * 2;

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  frac: number,
  col: string,
  bg = 'rgba(0,0,0,.55)',
) {
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  if (frac > 0) {
    ctx.save();
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.clip();
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w * clamp(frac, 0, 1), h);
    ctx.restore();
  }
}

/** World → screen, for the HUD's arrows (CSS px, or HUD px once scaled). */
export interface ScreenMapper {
  toScreen(x: number, y: number): [number, number];
}

export interface HudInput {
  frame: Frame;
  /** Screen size (CSS px). */
  w: number;
  h: number;
  /** How big the HUD is drawn (`hudScale`): it's laid out in w / scale × h / scale HUD px. */
  scale: number;
  camera: ScreenMapper;
  weather: WeatherLayer;
  touch: TouchControls;
  /** Who is choosing (player ids with a pending choice). */
  choosing: ReadonlySet<string>;
  /** The run's biome or arena name. */
  biomeName: string;
  fps: number | null;
  /** Called by the slot buttons and the touch pause button. */
  setSlot(i: number): void;
  togglePause(): void;
  /** Can move slots be switched now? */
  canAct: boolean;
  /** Auto or manual aim, and the HUD button that switches (also T). */
  aimMode: AimMode;
  toggleAim(): void;
  /** A gamepad is the input in use: its prompts, in its layout (null: keys, or touch). */
  pad: PadLayout | null;
  /** The stats panel under the HP bar (Settings → "Show stats"). */
  showStats: boolean;
  /** Spectating while down (co-op; null when it isn't offered: up, solo, nobody else left). */
  spectate: SpectateView | null;
}

/** The spectate controls under "You're down" (state in `spectate.ts`). */
export interface SpectateView {
  active: boolean;
  /** "Spectating bork's Pikachu" (only read while active). */
  label: string;
  toggle(): void;
  cycle(dir: -1 | 1): void;
}

/** The controls line shown early in a run (and in the pause menu). */
export function controlsHint(touch: boolean, aimMode: AimMode, pad = false): string {
  // With `{lstick}`-style glyph placeholders (`drawGlyphText`, `glyphText`).
  if (pad) return t('hud.padControls');
  if (!touch) return t('hud.wasdMove14Q');
  return t(aimMode === 'manual' ? 'hud.twinSticks' : 'hud.dragYourFingerToMove');
}

export class Hud {
  private banner: { text: string; t: number; dur: number } | null = null;
  private riftSeenAt: number | null = null;
  /** Local time each move was last cast (bonded slots flash their moves). */
  private castAt = new Map<string, number>();
  // The run's config (the HUD is built as the run starts).
  private readonly arenaTime = gameData().tuning.rift.arenaTime;
  private readonly momentum = gameData().tuning.momentum;
  /** The previous frame's Momentum stacks, and when they last went down (draining). */
  private lastMomentum = 0;
  private momentumDrainAt = -9;
  /** The first-time explanation was considered this run. */
  private momentumHinted = false;

  /** The scale the current frame is drawn at. */
  private scale = 1;
  /** Where the top-left block (HP, buffs, the team) ends, in CSS px (the network stats go under). */
  topLeftBottom = 0;

  /** The iPhone's margins (CSS px) in HUD px, so they stay the same on screen at any scale. */
  private safeArea(touch: TouchControls) {
    const a = touch.safeArea();
    const s = this.scale;
    return { top: a.top / s, right: a.right / s, bottom: a.bottom / s, left: a.left / s };
  }

  say(text: string, seconds: number): void {
    if (!text) return;
    this.banner = { text, t: 0, dur: seconds };
  }

  onCast(moveId: string, now: number): void {
    this.castAt.set(moveId, now);
  }

  draw(ctx: CanvasRenderingContext2D, input: HudInput): void {
    // Everything below is laid out in HUD px: the canvas is scaled, the screen is w / s × h / s,
    // arrows map world points into it, and touch buttons are registered back in CSS px.
    const s = input.scale > 0 ? input.scale : 1;
    this.scale = s;
    const world = input.camera;
    const k: HudInput = {
      ...input,
      w: input.w / s,
      h: input.h / s,
      camera: {
        toScreen: (x, y) => {
          const [sx, sy] = world.toScreen(x, y);
          return [sx / s, sy / s];
        },
      },
    };
    const { frame, w, h, touch } = k;
    const snap = frame.snap;
    const team = snap.team;
    const me = frame.self;
    const detail = frame.selfDetail;
    const now = frame.time;
    ctx.save();
    ctx.scale(s, s);
    ctx.textBaseline = 'alphabetic';
    touch.clearButtons();
    touch.buttonScale = s;
    if (this.banner && (this.banner.t += frame.dt) > this.banner.dur) this.banner = null;

    // ---------- XP bar (top edge) ----------
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(0, 0, w, 7);
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#4fd1ff');
    g.addColorStop(1, '#a98bff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w * clamp(team.xp / Math.max(1, team.xpNext), 0, 1), 7);

    // ---------- HP and level ----------
    const px = 16;
    const py = 20 + Math.min(16, touch.active ? this.safeArea(touch).top : 0);
    const info = frame.game.players.find((p) => p.id === frame.selfId);
    if (me) {
      ctx.font = F(800, 13);
      ctx.fillStyle = '#eaf2ff';
      ctx.textAlign = 'left';
      const mon = pokemonName(info?.dex ?? 25);
      ctx.fillText(mon, px, py + 10);
      if (info?.prestige) {
        ctx.fillStyle = '#ffd65c';
        ctx.fillText('★'.repeat(info.prestige), px + ctx.measureText(mon).width + 4, py + 10);
      }
      ctx.font = F(700, 11);
      ctx.fillStyle = '#ffcb3d';
      ctx.fillText(`${t('levelUp.lv')} ${team.level}`, px, py + 26);
      bar(ctx, px + 48, py + 17, 168, 11, me.hp / Math.max(1, me.maxHp), '#ff5f6d');
      ctx.font = F(700, 10);
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.ceil(me.hp)} / ${Math.round(me.maxHp)}`, px + 48 + 84, py + 26);
    }
    // Momentum, the active buffs, then the altar power.
    let bx = px;
    ctx.textAlign = 'left';
    if (me) {
      const stacks = frame.snap.self?.momentum ?? 0;
      bx = this.drawMomentum(ctx, stacks, momentumCap(this.momentum, snap.time), now, bx, py + 34);
    }
    const LBL = [
      t('game.buffAttack'),
      t('game.buffSpeed'),
      t('game.buffDefense'),
      t('game.buffRegen'),
    ];
    (detail?.buffs ?? [0, 0, 0, 0]).forEach((n, i) => {
      if (n <= 0) return;
      ctx.font = F(800, 9);
      const txt = `${LBL[i]} ×${n}`;
      const tw = ctx.measureText(txt).width + 12;
      roundRect(ctx, bx, py + 34, tw, 15, 7);
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fill();
      ctx.fillStyle = BUFF_COLORS[i] ?? '#fff';
      ctx.fillText(txt, bx + 6, py + 45);
      bx += tw + 5;
    });
    if (detail?.power) {
      const pw = altarPower(detail.power.id);
      ctx.font = F(800, 9);
      const txt = `${pw.name.toUpperCase()} ${detail.power.t}s`;
      const tw = ctx.measureText(txt).width + 12;
      roundRect(ctx, bx, py + 34, tw, 15, 7);
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fill();
      ctx.fillStyle = pw.color;
      ctx.fillText(txt, bx + 6, py + 45);
      bx += tw + 5;
    }

    // ---------- clock / biome / kills ----------
    ctx.textAlign = 'center';
    ctx.font = F(800, 26);
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fillText(mmss(snap.time), w / 2, 42);
    ctx.font = F(600, 10);
    ctx.fillStyle = '#8fa3c4';
    ctx.fillText(
      t('hud.defeatedCoins', { 0: k.biomeName.toUpperCase(), 1: team.kills, 2: team.coins }),
      w / 2,
      58,
    );

    // ---------- weather (top right) ----------
    const wx = k.weather.current;
    const wdef = wx ? weatherKind(wx.kind) : undefined;
    if (wx && wdef) {
      ctx.font = F(800, 11);
      ctx.textAlign = 'left';
      const txt = `${wdef.name.toUpperCase()} · ${Math.ceil(wx.left)}s`;
      const tw = ctx.measureText(txt).width + 40;
      const x0 = w - tw - 16 - (touch.active ? 56 : 0);
      const y0 = 14;
      roundRect(ctx, x0, y0, tw, 26, 9);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fill();
      drawIcon(ctx, wdef.icon, x0 + 6, y0 + 3, 20);
      ctx.fillStyle = wdef.color;
      ctx.fillText(txt, x0 + 32, y0 + 17);
    }

    // ---------- boss bars: the boss, then the wild legendaries (purple) ----------
    const bosses = frame.enemies
      .filter((e) => e.boss && !e.dead)
      .sort((a, b) => Number(a.wildLegend) - Number(b.wildLegend))
      .slice(0, 3);
    bosses.forEach((boss, i) => {
      const bw = Math.min(420, w - 80);
      const by = 70 + i * 16;
      const col = boss.wildLegend ? WILD_LEGEND : '#ffcb3d';
      bar(ctx, (w - bw) / 2, by, bw, 12, boss.hp / Math.max(1, boss.maxHp), col);
      ctx.font = F(800, 10);
      ctx.fillStyle = '#20160a';
      ctx.textAlign = 'center';
      ctx.fillText(pokemonName(boss.dex).toUpperCase(), w / 2, by + 10);
    });

    // ---------- shinies off screen: a flashing arrow on the edge ----------
    const cam = k.camera;
    const pulse = 0.6 + Math.sin(now * 6.25) * 0.4;
    for (const e of frame.enemies) {
      if (!e.shiny || e.dead) continue;
      const [sx, sy] = cam.toScreen(e.x, e.y);
      if (sx > 0 && sx < w && sy > 0 && sy < h) continue;
      const M = 34;
      const ex = clamp(sx, M, w - M);
      const ey = clamp(sy, M + 60, h - M - 70);
      const a = Math.atan2(sy - ey, sx - ex);
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.translate(ex, ey);
      ctx.fillStyle = '#9ae6ff';
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 24, Math.sin(a) * 24);
      ctx.lineTo(Math.cos(a + 2.5) * 12, Math.sin(a + 2.5) * 12);
      ctx.lineTo(Math.cos(a - 2.5) * 12, Math.sin(a - 2.5) * 12);
      ctx.fill();
      ctx.globalAlpha = 1;
      drawIcon(ctx, 'shiny', -12, -12, 24);
      ctx.restore();
    }

    let teamTop = py + (bx > px ? 56 : 40);
    const momentum = 1 + this.momentum.perStack * (frame.snap.self?.momentum ?? 0);
    const statsRows = visibleStatRows(k.showStats && !!me, frame.snap.stats, momentum);
    if (statsRows) teamTop += drawStatsPanel(ctx, statsRows, F, px, teamTop - 4) + 4;
    const mates = frame.players.filter((p) => p.id !== frame.selfId && !p.left).length;
    this.topLeftBottom = (teamTop + mates * 15) * s;
    if (frame.game.players.length > 1) this.drawTeam(ctx, k, px, teamTop);

    // ---------- rift: a big arrow on the edge, or a bouncing one over it ----------
    const rift = snap.misc.rift;
    if (rift && this.riftSeenAt === null) this.riftSeenAt = now;
    if (!rift) this.riftSeenAt = null;
    if (rift && me) {
      const [sx, sy] = cam.toScreen(rift.x, rift.y - 40);
      const beat = 0.5 + Math.sin(now * 7) * 0.5;
      const label = t('hud.riftMS2', {
        0: Math.round(Math.hypot(me.x - rift.x, me.y - rift.y) / 32),
        1: Math.ceil(rift.ttl),
      });
      const off = sx < 0 || sx > w || sy < 0 || sy > h;
      ctx.save();
      if (off) {
        const M = 52;
        const ex = clamp(sx, M, w - M);
        const ey = clamp(sy, M + 70, h - M - 80);
        const a = Math.atan2(sy - ey, sx - ex);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        ctx.translate(ex, ey);
        ctx.globalAlpha = 0.18 + beat * 0.22;
        ctx.fillStyle = '#b48aff';
        ctx.beginPath();
        ctx.arc(0, 0, 30 + beat * 8, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        const tri = (s: number) => {
          ctx.beginPath();
          ctx.moveTo(ca * 40 * s, sa * 40 * s);
          ctx.lineTo(Math.cos(a + 2.45) * 20 * s, Math.sin(a + 2.45) * 20 * s);
          ctx.lineTo(Math.cos(a - 2.45) * 20 * s, Math.sin(a - 2.45) * 20 * s);
          ctx.closePath();
        };
        tri(1.12);
        ctx.fillStyle = '#1a0b33';
        ctx.fill();
        tri(1);
        ctx.fillStyle = beat > 0.5 ? '#e2d0ff' : '#a06bff';
        ctx.fill();
        ctx.font = F(800, 12);
        ctx.textAlign = ca > 0.3 ? 'right' : ca < -0.3 ? 'left' : 'center';
        const lx = -ca * 34;
        const ly = -sa * 30 + 4;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,.85)';
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = '#e2d0ff';
        ctx.fillText(label, lx, ly);
      } else {
        const by = sy - 46 - Math.abs(Math.sin(now * 4)) * 10;
        ctx.translate(sx, by);
        ctx.beginPath();
        ctx.moveTo(-15, -12);
        ctx.lineTo(15, -12);
        ctx.lineTo(0, 8);
        ctx.closePath();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#1a0b33';
        ctx.stroke();
        ctx.fillStyle = beat > 0.5 ? '#e2d0ff' : '#a06bff';
        ctx.fill();
        ctx.font = F(800, 11);
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,.85)';
        const l2 = t('hud.riftS', { 0: Math.ceil(rift.ttl) });
        ctx.strokeText(l2, 0, -18);
        ctx.fillStyle = '#e2d0ff';
        ctx.fillText(l2, 0, -18);
      }
      ctx.restore();
    }
    const arena = snap.misc.arena;
    if (arena && arena.phase === 'fight') {
      ctx.textAlign = 'center';
      ctx.font = F(800, 12);
      ctx.fillStyle = '#d9c2ff';
      ctx.fillText(
        t('hud.rift', { 0: mmss(this.arenaTime - arena.t) }),
        w / 2,
        bosses.length ? 98 : 76,
      );
    }

    this.drawEvents(ctx, k);

    // The "a rift has opened" notice (the other banners don't cover it).
    const since = this.riftSeenAt === null ? null : now - this.riftSeenAt;
    if (rift && since !== null && since < 4.5 && rift.t < 5) {
      const a = Math.min(1, since * 4, (4.5 - since) * 2);
      const pop = 1 + Math.max(0, 0.25 - since) * 1.6;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(w / 2, h * 0.2);
      ctx.scale(pop, pop);
      const t1 = t('hud.aRiftHasOpened');
      const t2 = t('hud.followThePurpleArrowA');
      ctx.font = F(800, 20);
      const w1 = ctx.measureText(t1).width;
      ctx.font = F(700, 11);
      const bw = Math.min(w - 24, Math.max(w1, ctx.measureText(t2).width) + 36);
      roundRect(ctx, -bw / 2, -26, bw, 52, 10);
      ctx.fillStyle = 'rgba(26,11,51,.88)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#b48aff';
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.font = F(800, 20);
      ctx.fillStyle = '#e2d0ff';
      ctx.fillText(t1, 0, -2);
      ctx.font = F(700, 11);
      ctx.fillStyle = '#c9b0ff';
      ctx.fillText(t2, 0, 16);
      ctx.restore();
    }

    const ban = this.banner;
    if (ban) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, ban.t * 1.6, (ban.dur - ban.t) * 3);
      ctx.font = F(800, 22);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffcb3d';
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.lineWidth = 4;
      ctx.strokeText(ban.text, w / 2, h * 0.3);
      ctx.fillText(ban.text, w / 2, h * 0.3);
      ctx.restore();
    }

    this.drawSlots(ctx, k);

    // ---------- pause button (touch) ----------
    if (touch.active) {
      const sa = this.safeArea(touch);
      const bxp = w - 52 - Math.min(44, sa.right);
      const byp = 12 + Math.min(20, sa.top);
      const bs = 40;
      roundRect(ctx, bxp, byp, bs, bs, 10);
      ctx.fillStyle = 'rgba(10,16,28,.7)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(244,248,255,.8)';
      ctx.stroke();
      ctx.fillStyle = '#f4f8ff';
      ctx.fillRect(bxp + 13, byp + 11, 5, 18);
      ctx.fillRect(bxp + 22, byp + 11, 5, 18);
      touch.addButton(bxp, byp, bs, bs, () => k.togglePause(), 8);
    }

    this.drawAimToggle(ctx, k);

    // Controls hint, early in the run.
    if (snap.time < 14) {
      ctx.font = F(600, 10);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(180,200,230,.55)';
      if (k.pad) {
        ctx.font = F(600, 13);
        const gs = glyphDrawSize(ctx, PAD_HINT_GLYPH);
        drawGlyphText(
          ctx,
          controlsHint(false, k.aimMode, true),
          w / 2,
          h - PAD_HINT_BOTTOM - gs / 2,
          PAD_HINT_GLYPH,
          { layout: k.pad, maxWidth: w - 24 },
        );
      } else ctx.fillText(controlsHint(touch.active, k.aimMode), w / 2, h - 4);
    }

    // You're down.
    if (me?.dead && !snap.ended) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = F(800, 20);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      const solo = frame.game.players.length === 1;
      const all = frame.players.every((p) => p.dead || p.left);
      const msg = all ? t('hud.everyoneIsDown') : solo ? '' : t('hud.youReDownATeammate');
      if (msg) {
        ctx.strokeText(msg, w / 2, h * 0.62);
        ctx.fillStyle = '#ffb0b8';
        ctx.fillText(msg, w / 2, h * 0.62);
      }
      const f = me.reviveT / REVIVE_SECONDS;
      if (f > 0) bar(ctx, w / 2 - 110, h * 0.62 + 12, 220, 10, f, '#5fe08a');
      ctx.restore();
      if (k.spectate) this.drawSpectate(ctx, k, k.spectate, h * 0.62 + 30);
    }

    if (k.fps !== null) {
      ctx.font = F(700, 11);
      ctx.textAlign = 'right';
      ctx.fillStyle = k.fps >= 50 ? '#5fe08a' : k.fps >= 30 ? '#ffd23f' : '#ff5f6d';
      ctx.fillText(`${k.fps} FPS`, w - 10, h - 8);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- aim switch

  /** Top right, under the weather (and the touch pause button): "AIM: AUTO" / "AIM: MANUAL". */
  drawAimToggle(ctx: CanvasRenderingContext2D, k: HudInput): void {
    const { w, touch } = k;
    const manual = k.aimMode === 'manual';
    const label = t(manual ? 'hud.aimManual' : 'hud.aimAuto');
    ctx.save();
    ctx.font = F(800, 11);
    // Room for the key (T) or the gamepad's glyph (R3, bigger).
    const keyW = k.pad ? 26 : touch.active ? 0 : 18;
    const bw = Math.ceil(ctx.measureText(label).width) + 36 + keyW;
    const bh = 28;
    let right = w - 16;
    let top = 48;
    if (touch.active) {
      const sa = this.safeArea(touch);
      right = w - 12 - Math.min(44, sa.right);
      top = 12 + Math.min(20, sa.top) + 48;
    }
    const x = right - bw;
    roundRect(ctx, x, top, bw, bh, 9);
    ctx.fillStyle = manual ? 'rgba(60,24,10,.85)' : 'rgba(10,16,28,.7)';
    ctx.fill();
    ctx.lineWidth = manual ? 2 : 1.5;
    ctx.strokeStyle = manual ? '#ff9a6b' : 'rgba(244,248,255,.55)';
    ctx.stroke();
    // A crosshair.
    const cx = x + 15;
    const cy = top + bh / 2;
    ctx.strokeStyle = manual ? '#ffd23f' : '#c8d6ee';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, TAU);
    ctx.moveTo(cx - 9, cy);
    ctx.lineTo(cx - 3, cy);
    ctx.moveTo(cx + 3, cy);
    ctx.lineTo(cx + 9, cy);
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx, cy - 3);
    ctx.moveTo(cx, cy + 3);
    ctx.lineTo(cx, cy + 9);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = manual ? '#ffd23f' : '#eaf2ff';
    ctx.fillText(label, x + 29, cy + 4);
    if (k.pad) {
      // The button that does the same: R3.
      drawGlyph(ctx, 'r3', x + bw - keyW - 2, cy - 12, 24, k.pad);
    } else if (keyW) {
      // The key that does the same.
      const kx = x + bw - keyW - 4;
      roundRect(ctx, kx, cy - 8, 16, 16, 4);
      ctx.fillStyle = 'rgba(255,255,255,.12)';
      ctx.fill();
      ctx.font = F(800, 9);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(234,242,255,.8)';
      ctx.fillText('T', kx + 8, cy + 3);
    }
    ctx.restore();
    touch.addButton(x, top, bw, bh, () => k.toggleAim(), 6);
  }

  // ---------------------------------------------------------------- spectating

  /**
   * Under "You're down": a "Spectate" button, or while spectating "◀ Spectating bork's Pikachu ▶"
   * with a "Back to you" button under it. Each shows its key (C, ← →) or pad glyph (Back, d-pad).
   */
  private drawSpectate(ctx: CanvasRenderingContext2D, k: HudInput, v: SpectateView, top: number) {
    const { w, touch } = k;
    const keys = !k.pad && !touch.active;
    ctx.save();
    // A HUD button in the aim switch's look, centred on `cx`; returns its width.
    const button = (cx: number, y: number, label: string, key: string, glyph: PadButton) => {
      ctx.font = F(800, 11);
      const keyW = k.pad ? 26 : keys ? ctx.measureText(key).width + 10 : 0;
      const bw = Math.ceil(ctx.measureText(label).width) + 20 + (keyW ? keyW + 4 : 0);
      const bh = 26;
      const x = cx - bw / 2;
      roundRect(ctx, x, y, bw, bh, 9);
      ctx.fillStyle = 'rgba(10,16,28,.78)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(244,248,255,.6)';
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = '#eaf2ff';
      ctx.fillText(label, x + 10, y + bh / 2 + 4);
      if (k.pad) drawGlyph(ctx, glyph, x + bw - keyW - 2, y + bh / 2 - 12, 24, k.pad);
      else if (keys) {
        const kx = x + bw - keyW - 6;
        roundRect(ctx, kx, y + bh / 2 - 8, keyW, 16, 4);
        ctx.fillStyle = 'rgba(255,255,255,.12)';
        ctx.fill();
        ctx.font = F(800, 9);
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(234,242,255,.8)';
        ctx.fillText(key, kx + keyW / 2, y + bh / 2 + 3);
      }
      return { x, y, bw, bh };
    };
    if (!v.active) {
      const b = button(w / 2, top, t('hud.spectate'), 'C', 'select');
      touch.addButton(b.x, b.y, b.bw, b.bh, () => v.toggle(), 6);
      ctx.restore();
      return;
    }
    // The label between the arrows.
    ctx.font = F(800, 14);
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,.75)';
    const cy = top + 14;
    ctx.strokeText(v.label, w / 2, cy + 5);
    ctx.fillStyle = '#fff3c4';
    ctx.fillText(v.label, w / 2, cy + 5);
    const half = Math.ceil(ctx.measureText(v.label).width / 2);
    const S = 28;
    for (const dir of [-1, 1] as const) {
      const bx = dir < 0 ? w / 2 - half - 12 - S : w / 2 + half + 12;
      roundRect(ctx, bx, cy - S / 2, S, S, 8);
      ctx.fillStyle = 'rgba(10,16,28,.78)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(244,248,255,.6)';
      ctx.stroke();
      // A triangle pointing left or right.
      const mx = bx + S / 2;
      ctx.fillStyle = '#eaf2ff';
      ctx.beginPath();
      ctx.moveTo(mx + 6 * dir, cy);
      ctx.lineTo(mx - 4 * dir, cy - 7);
      ctx.lineTo(mx - 4 * dir, cy + 7);
      ctx.closePath();
      ctx.fill();
      touch.addButton(bx, cy - S / 2, S, S, () => v.cycle(dir), 6);
    }
    // How to switch, under the label: the d-pad glyph or the arrow keys, then "switch".
    const hintY = cy + S / 2 + 4;
    if (k.pad || keys) {
      ctx.font = F(600, 10);
      const word = t('hud.spectateSwitch');
      const iconW = k.pad ? 20 : 35;
      let x = w / 2 - (iconW + 5 + ctx.measureText(word).width) / 2;
      if (k.pad) drawGlyph(ctx, 'dpadH', x, hintY - 1, 20, k.pad);
      else
        for (const dir of [-1, 1]) {
          // Key chips with arrows (the pixel font has no arrow characters).
          roundRect(ctx, x + (dir < 0 ? 0 : 19), hintY + 2, 16, 14, 4);
          ctx.fillStyle = 'rgba(255,255,255,.12)';
          ctx.fill();
          const mx = x + (dir < 0 ? 8 : 27);
          const my = hintY + 9;
          ctx.fillStyle = 'rgba(234,242,255,.8)';
          ctx.beginPath();
          ctx.moveTo(mx + 3.5 * dir, my);
          ctx.lineTo(mx - 2.5 * dir, my - 4);
          ctx.lineTo(mx - 2.5 * dir, my + 4);
          ctx.closePath();
          ctx.fill();
        }
      x += iconW + 5;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(200,214,238,.75)';
      ctx.fillText(word, x, hintY + 13);
    }
    const b = button(
      w / 2,
      hintY + (k.pad || keys ? 20 : 4),
      t('hud.stopSpectating'),
      'C',
      'select',
    );
    touch.addButton(b.x, b.y, b.bw, b.bh, () => v.toggle(), 6);
    ctx.restore();
  }

  // ---------------------------------------------------------------- momentum

  /**
   * The kill-streak chip, in the menus' charcoal look: "MOMENTUM ×1.36" over ten pips (filled
   * against the run's current cap). Gold when
   * high (pulsing at the cap); dimmed while it drains. Returns the x after it.
   */
  private drawMomentum(
    ctx: CanvasRenderingContext2D,
    stacks: number,
    cap: number,
    now: number,
    x: number,
    y: number,
  ): number {
    const cfg = this.momentum;
    if (stacks < this.lastMomentum - 0.05) this.momentumDrainAt = now;
    this.lastMomentum = stacks;
    if (stacks < 0.05) return x;
    if (!this.momentumHinted && stacks >= MOMENTUM_HINT_STACKS) {
      this.momentumHinted = true;
      if (!seenHint(MOMENTUM_HINT_KEY)) this.say(t('hud.momentumHint'), 6);
    }
    // Against the current cap (it grows over the run): a full bar early is a smaller ×.
    const frac = clamp(stacks / cap, 0, 1);
    const high = frac >= MOMENTUM_HIGH;
    const draining = now - this.momentumDrainAt < 0.35;
    const mul = 1 + cfg.perStack * stacks;
    ctx.save();
    ctx.font = F(800, 10);
    ctx.textAlign = 'left';
    const txt = `${t('hud.momentum')} ×${mul.toFixed(2)}`;
    const w = Math.ceil(ctx.measureText(txt).width) + 12;
    const H = 18;
    ctx.globalAlpha = draining ? 0.72 : 1;
    // A hard offset shadow, the window fill, and an inner rule (gold at the cap).
    ctx.fillStyle = 'rgba(20,16,18,.55)';
    ctx.fillRect(x + 2, y + 2, w, H);
    ctx.fillStyle = CHARCOAL.bg;
    ctx.fillRect(x, y, w, H);
    const atCap = frac >= 0.98 && !draining;
    ctx.strokeStyle = atCap
      ? `rgba(255,214,92,${(0.55 + Math.sin(now * 8) * 0.45).toFixed(2)})`
      : CHARCOAL.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, H - 1);
    ctx.fillStyle = draining ? CHARCOAL.muted : high ? CHARCOAL.gold : CHARCOAL.text;
    ctx.fillText(txt, x + 6, y + 11);
    // Ten pips under the text; the last one fills partly (and empties as it drains).
    const PIPS = 10;
    const pw = (w - 12 - (PIPS - 1)) / PIPS;
    const fill = draining ? CHARCOAL.muted : high ? CHARCOAL.gold : CHARCOAL.accent;
    for (let i = 0; i < PIPS; i++) {
      const px = x + 6 + i * (pw + 1);
      ctx.fillStyle = CHARCOAL.rule;
      ctx.fillRect(px, y + 13, pw, 3);
      const f = clamp(frac * PIPS - i, 0, 1);
      if (f > 0) {
        ctx.fillStyle = fill;
        ctx.fillRect(px, y + 13, pw * f, 3);
      }
    }
    ctx.restore();
    return x + w + 5;
  }

  // ---------------------------------------------------------------- move slots

  private drawSlots(ctx: CanvasRenderingContext2D, k: HudInput): void {
    const { frame, w, h, touch } = k;
    const detail = frame.selfDetail;
    const me = frame.self;
    if (!detail || !me) return;
    const data = gameData();
    const cds = frame.snap.self?.cooldowns ?? [];
    const cdOf = (id: string) => {
      const i = detail.moves.findIndex((m) => m.id === id);
      return i < 0 ? 0 : (cds[i] ?? 0);
    };
    const S = 54;
    const GAP = 9;
    const n = Math.max(1, detail.slots.length);
    const totalW = n * S + (n - 1) * GAP;
    const sx = (w - totalW) / 2;
    // Above the iPhone's home bar (taps there sometimes don't arrive).
    const bottom = k.pad ? Math.max(18, padHintBand(ctx)) : 18;
    const sy = h - S - bottom - (touch.active ? Math.min(28, this.safeArea(touch).bottom) : 0);
    for (let i = 0; i < n; i++) {
      const group = detail.slots[i] ?? [];
      const id = group[0];
      const m = id ? detail.moves.find((x) => x.id === id) : undefined;
      const fused = group.length > 1;
      const on = i === me.active;
      const x = sx + i * (S + GAP);
      const y = on ? sy - 6 : sy;
      if (m) touch.addButton(x, y, S, S, () => k.canAct && !on && k.setSlot(i), GAP / 2 + 3);
      const col = m ? typeColor(m.type) : '#4a5468';
      roundRect(ctx, x, y, S, S, 12);
      ctx.fillStyle = on ? 'rgba(20,30,50,.95)' : 'rgba(10,16,28,.8)';
      ctx.fill();
      ctx.lineWidth = on ? 2.5 : fused || m?.evolved ? 2 : 1.2;
      // Bond: pink border. Evolved: gold.
      ctx.strokeStyle = fused ? BOND : m?.evolved ? '#ffd23f' : on ? col : 'rgba(140,170,210,.22)';
      ctx.stroke();
      if (!m) continue;
      if (fused) {
        // A bond: its moves in a 2×2 grid, each with its cooldown.
        const C = 22;
        const P = (S - C * 2) / 3;
        group.forEach((gid, j) => {
          const gm = detail.moves.find((q) => q.id === gid);
          const cx = x + P + (j % 2) * (C + P);
          const cy = y + P + Math.floor(j / 2) * (C + P);
          drawIcon(ctx, `move:${gid}`, cx, cy, C);
          const f = gm?.kind === 'orbit' ? 0 : cdOf(gid);
          if (f > 0) {
            ctx.fillStyle = 'rgba(0,0,0,.55)';
            ctx.fillRect(cx, cy, C, C * f);
          }
          if (gm?.evolved) {
            ctx.strokeStyle = '#ffd23f';
            ctx.lineWidth = 1;
            ctx.strokeRect(cx + 0.5, cy + 0.5, C - 1, C - 1);
          }
          // A flash on each cast.
          const fl = 1 - (frame.time - (this.castAt.get(gid) ?? -9)) / 0.18;
          if (fl > 0) {
            ctx.fillStyle = `rgba(255,255,255,${(fl * 0.55).toFixed(2)})`;
            ctx.fillRect(cx, cy, C, C);
          }
        });
      } else {
        // Cooldown: drains from the bottom up.
        const f = m.kind === 'orbit' ? 0 : cdOf(m.id);
        if (f > 0) {
          ctx.save();
          roundRect(ctx, x, y, S, S, 12);
          ctx.clip();
          ctx.fillStyle = 'rgba(0,0,0,.6)';
          ctx.fillRect(x, y, S, S * f);
          ctx.restore();
        }
        drawIcon(ctx, `move:${m.id}`, x + (S - 32) / 2, y + (S - 32) / 2 - 2, 32);
        // Level dots.
        const def = data.moveById.get(m.id);
        const dots = def ? (data.moves.upgradeLadders[def.kind]?.length ?? 0) + 1 : 1;
        const dw = 4;
        const dg = 2;
        const tw = dots * dw + (dots - 1) * dg;
        for (let d = 0; d < dots; d++) {
          ctx.fillStyle = d < m.level ? col : 'rgba(255,255,255,.18)';
          ctx.fillRect(x + (S - tw) / 2 + d * (dw + dg), y + S - 9, dw, 3);
        }
      }
      ctx.font = F(800, 9);
      ctx.fillStyle = fused ? BOND : on ? col : 'rgba(180,200,230,.6)';
      ctx.textAlign = 'left';
      const button = k.pad ? SLOT_PAD[i] : undefined;
      // The pad's button sits on the slot's corner, big enough to read.
      if (button) drawGlyph(ctx, button, x - 8, y - 8, 24, k.pad ?? undefined);
      else ctx.fillText(String(i + 1), x + 3, y + 10);
      // The active one's name on top ("Ember +2" with a bond).
      if (on) {
        ctx.font = F(700, 10);
        ctx.textAlign = 'center';
        ctx.fillStyle = fused ? BOND : col;
        const name = moveName(m.id);
        // Higher with the pad, clear of the button's glyph on the corner.
        const ny = button ? y - 12 : y - 7;
        ctx.fillText(fused ? `${name} +${group.length - 1}` : name, x + S / 2, ny);
      }
    }
    // A saved bond (no two loose moves yet).
    if (detail.bonds > 0) {
      const bx = sx + totalW + 12;
      const by = sy + S / 2 - 12;
      drawIcon(ctx, 'bond', bx, by, 24);
      if (detail.bonds > 1) {
        ctx.font = F(800, 10);
        ctx.textAlign = 'left';
        ctx.fillStyle = BOND;
        ctx.fillText(`×${detail.bonds}`, bx + 25, by + 20);
      }
    }
    // The held item, left of the moves.
    const ix = sx - S - 18;
    roundRect(ctx, ix, sy, S, S, 12);
    ctx.fillStyle = detail.item ? 'rgba(40,30,10,.9)' : 'rgba(10,16,28,.55)';
    ctx.fill();
    ctx.lineWidth = detail.item ? 2 : 1;
    ctx.strokeStyle = detail.item ? '#ffd23f' : 'rgba(140,170,210,.18)';
    ctx.stroke();
    if (detail.item) {
      drawIcon(ctx, detail.item, ix + (S - 36) / 2, sy + (S - 36) / 2, 36);
      ctx.font = F(700, 9);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd23f';
      ctx.fillText(itemName(detail.item), ix + S / 2, sy - 6);
    }
  }

  // ---------------------------------------------------------------- co-op

  /**
   * Each teammate's HP under yours, with their status (down, choosing, offline); arrows on the
   * screen edge towards the ones out of view, with their name and distance.
   */
  private drawTeam(ctx: CanvasRenderingContext2D, k: HudInput, px: number, top: number): void {
    const { frame, w, h, camera: cam } = k;
    const now = frame.time;
    const me = frame.self;
    let y = top;
    ctx.textAlign = 'left';
    const mates = frame.players.filter((p) => p.id !== frame.selfId && !p.left);
    const name = (id: string) => frame.game.players.find((p) => p.id === id)?.username ?? id;
    for (const o of mates) {
      const color = PLAYER_COLORS[o.index] ?? '#fff';
      ctx.font = F(800, 10);
      ctx.fillStyle = o.connected ? color : '#7d8899';
      ctx.fillText(name(o.id), px, y + 9);
      const lx = px + 78;
      bar(
        ctx,
        lx,
        y + 1,
        110,
        8,
        o.dead ? 0 : o.hp / Math.max(1, o.maxHp),
        o.dead ? '#ff5f6d' : '#5fe08a',
      );
      ctx.font = F(800, 9);
      const status = !o.connected
        ? [t('game.offline'), '#9aa2ae']
        : o.dead
          ? [t('hud.down'), Math.sin(now * 8) > 0 ? '#ff8a96' : '#ffd0d5']
          : k.choosing.has(o.id)
            ? [t('game.choosing'), '#ffd23f']
            : null;
      if (status) {
        ctx.fillStyle = status[1]!;
        ctx.fillText(status[0]!, lx + 116, y + 9);
      }
      y += 15;
    }
    if (!me) return;
    for (const o of mates) {
      if (!o.connected) continue;
      const info = frame.game.players.find((p) => p.id === o.id);
      const [sx, sy] = cam.toScreen(o.x, o.y - bodyHeight(info?.dex ?? 25) * 0.5);
      if (sx > 0 && sx < w && sy > 0 && sy < h) continue;
      const M = 42;
      const ex = clamp(sx, M, w - M);
      const ey = clamp(sy, M + 70, h - M - 80);
      const a = Math.atan2(sy - ey, sx - ex);
      const metres = Math.round(Math.hypot(me.x - o.x, me.y - o.y) / 32);
      const base = PLAYER_COLORS[o.index] ?? '#fff';
      const col = o.dead ? (Math.sin(now * 8) > 0 ? '#ff5f6d' : '#ffd0d5') : base;
      const nm = name(o.id);
      ctx.save();
      ctx.translate(ex, ey);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath();
      ctx.arc(0, 0, 17, 0, TAU);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 28, Math.sin(a) * 28);
      ctx.lineTo(Math.cos(a + 2.4) * 14, Math.sin(a + 2.4) * 14);
      ctx.lineTo(Math.cos(a - 2.4) * 14, Math.sin(a - 2.4) * 14);
      ctx.closePath();
      ctx.fill();
      ctx.font = F(800, 14);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.fillText(nm.charAt(0).toUpperCase(), 0, 5);
      const lx = -Math.cos(a) * 30;
      const ly = -Math.sin(a) * 26 + 4;
      ctx.font = F(800, 12);
      const label = o.dead
        ? t('hud.needsHelpM', { 0: nm, 1: metres })
        : t('game.mateDistance', { 0: nm, 1: metres });
      ctx.textAlign = Math.cos(a) > 0.3 ? 'right' : Math.cos(a) < -0.3 ? 'left' : 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = col;
      ctx.fillText(label, lx, ly);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- run events

  private drawEvents(ctx: CanvasRenderingContext2D, k: HudInput): void {
    const { frame, w } = k;
    const me = frame.self;
    const misc = frame.snap.misc;
    const L = misc.lost;
    if (L && me) {
      const waiting = L.phase === 'wait';
      const to: [number, number] = waiting ? [L.x, L.y - 10] : [L.tx, L.ty];
      const metres = Math.round(Math.hypot(me.x - to[0], me.y - to[1]) / 32);
      this.edgeArrow(
        ctx,
        k,
        to[0],
        to[1],
        '#7dffb0',
        waiting ? `${pokemonName(L.dex)} · ${metres} m` : t('hud.markerM', { 0: metres }),
      );
    }
    for (const e of frame.enemies) {
      if (e.dead) continue;
      if (e.behavior === 'thief')
        this.edgeArrow(ctx, k, e.x, e.y - 10, '#ffd23f', pokemonName(e.dex));
      else if (e.wildLegend) this.edgeArrow(ctx, k, e.x, e.y - 10, WILD_LEGEND, pokemonName(e.dex));
    }
    const ev = misc.event;
    if (ev && ev.id !== 'lost' && ev.dur !== null) {
      const left = Math.max(0, Math.ceil(ev.dur - ev.t));
      const txt =
        ev.id === 'gold'
          ? t('hud.goldenHourS', { 0: left })
          : t('hud.hordeS', { 0: typeName(ev.type ?? 'normal').toUpperCase(), 1: left });
      ctx.save();
      ctx.font = F(800, 12);
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.strokeText(txt, w / 2, 112);
      ctx.fillStyle = ev.id === 'gold' ? '#ffd23f' : typeColor(ev.type ?? 'normal');
      ctx.fillText(txt, w / 2, 112);
      ctx.restore();
    }
  }

  private edgeArrow(
    ctx: CanvasRenderingContext2D,
    k: HudInput,
    x: number,
    y: number,
    col: string,
    label: string,
  ): void {
    const { w, h, camera: cam, frame } = k;
    const [sx, sy] = cam.toScreen(x, y);
    if (sx > 0 && sx < w && sy > 0 && sy < h) return;
    const M = 44;
    const ex = clamp(sx, M, w - M);
    const ey = clamp(sy, M + 70, h - M - 80);
    const a = Math.atan2(sy - ey, sx - ex);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const pulse = 0.65 + Math.sin(frame.time * 6.25) * 0.35;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.globalAlpha = pulse;
    ctx.beginPath();
    ctx.moveTo(ca * 30, sa * 30);
    ctx.lineTo(Math.cos(a + 2.45) * 15, Math.sin(a + 2.45) * 15);
    ctx.lineTo(Math.cos(a - 2.45) * 15, Math.sin(a - 2.45) * 15);
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = F(800, 11);
    ctx.textAlign = ca > 0.3 ? 'right' : ca < -0.3 ? 'left' : 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.strokeText(label, -ca * 26, -sa * 24 + 4);
    ctx.fillStyle = col;
    ctx.fillText(label, -ca * 26, -sa * 24 + 4);
    ctx.restore();
  }
}
