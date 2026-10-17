// Drawing the run's entities. The snapshots say where things are; the
// client keeps an animator per Pokémon and plays one-shot animations from events (casts, hits,
// enemy actions) and a fading Faint for the defeated.
import { loadGameData, type AnimationName } from '@pokesurvivor/data';
import { REVIVE_SECONDS, facingOf, moveStatsAt } from '@pokesurvivor/sim';
import type {
  NetEnemy,
  NetField,
  NetHazard,
  NetMisc,
  NetPickup,
  NetPlayer,
  NetProjectile,
  PlayerDetail,
} from '@pokesurvivor/netclient';
import { MEGA_RAINBOW, drawIcon, typeColor } from '../../icons.js';
import { gameData } from '../../live-config.js';
import { settings } from '../../settings.js';
import {
  Animator,
  PX,
  bodyHeight,
  drawShadow,
  hasAnim,
  hasShiny,
  megaSpriteRef,
  stableDir,
  type SpriteRef,
} from '../../sprites.js';
import type { Frame } from '../frame.js';
import type { Camera } from './camera.js';
import type { FX } from './fx.js';
import { propSprite } from './tiles.js';
import { drawVfx, vfxForMove, vfxForType, vfxIsDir, vfxSpins } from './vfx.js';

/** Projectiles fly this high above their ground position (legacy G.LIFT). */
export const LIFT = 18;
export const PLAYER_COLORS = ['#ffcb3d', '#5fc8ff', '#7ee07a', '#ff8ad8'];
const BUFF_COLORS = ['#ff6b4d', '#7fe0ff', '#b0b8c8', '#5fe08a'];
/** An altar power's name and colour (world.json). */
export function altarPower(id: string): { name: string; color: string } {
  const p = loadGameData().world.altarPowers.find((x) => x.id === id);
  return { name: p?.name ?? id, color: p?.color ?? '#ffd23f' };
}

/** The family → animation of a cast (original implementation `cast`). */
const CAST_ANIM: Record<string, AnimationName> = {
  melee: 'Attack',
  beam: 'Shoot',
  projectile: 'Shoot',
  nova: 'Attack',
  aura: 'Charge',
  buff: 'Charge',
  orbit: 'Charge',
  boomerang: 'Shoot',
  chain: 'Shoot',
  mine: 'Charge',
  meteor: 'Charge',
  turret: 'Charge',
  dash: 'Attack',
  trail: 'Walk',
  cone: 'Shoot',
};
const ACTION_ANIM: Record<string, [AnimationName, number]> = {
  shoot: ['Shoot', 1],
  charge: ['Charge', 1.6],
  dash: ['Attack', 1.4],
  strike: ['Attack', 1.5],
  heal: ['Charge', 1],
  shield: ['Charge', 1],
  summon: ['Charge', 1],
  jump: ['Charge', 1.4],
  land: ['Attack', 1.4],
  fuse: ['Charge', 1.2],
};
const SUPPORT_ICON: Record<string, string> = {
  healer: 'heart',
  shielder: 'shield',
  summoner: 'friends',
};

const PICKUP: Record<string, { color: string; glow: string; r: number }> = {
  xp: { color: '#7fe0ff', glow: '#2a8fd0', r: 4.5 },
  'xp-big': { color: '#ffd95e', glow: '#c08a10', r: 7 },
  heal: { color: '#5fe08a', glow: '#1f8f4d', r: 6.5 },
  magnet: { color: '#ff9ed8', glow: '#b03d84', r: 6.5 },
  bomb: { color: '#ff7b3d', glow: '#b03d10', r: 6.5 },
  coin: { color: '#ffd23f', glow: '#b8860b', r: 5.5 },
  ticket: { color: '#ffd23f', glow: '#c08a10', r: 7 },
  ticket10: { color: '#c47bff', glow: '#8a3fd0', r: 8 },
  gem: { color: '#5fe3ff', glow: '#2a8fd0', r: 8 },
  item: { color: '#ffd23f', glow: '#c08a10', r: 9 },
};
const PICKUP_ICON: Record<string, string> = {
  heal: 'berry',
  magnet: 'magnet',
  bomb: 'bomb',
  ticket: 'ticket',
  ticket10: 'ticket10',
  gem: 'gem',
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** `alpha` (0–1) as the two hex digits of a `#rrggbbaa` colour. */
const alphaHex = (alpha: number) =>
  Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
/** How white the sprite glows through a Mega Evolution (0–1): rising, held over the swap, gone. */
export function megaWhite(u: number): number {
  if (u < 0.4) return (u / 0.4) * 0.9;
  if (u < MEGA_SWAP + 0.1) return 0.9;
  return Math.max(0, 0.9 * (1 - (u - MEGA_SWAP - 0.1) / 0.25));
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const TAU = Math.PI * 2;

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), 0, 0, TAU);
}

interface PlayerVis {
  anim: Animator;
  /** The sprite drawn: the dex, or its Mega form's key once it has evolved. */
  ref: SpriteRef;
  flash: number;
  dead: boolean;
  /** Seconds since it went down (a form without Faint fades its held Hurt instead). */
  deadT: number;
  hp: number;
  /** Shiny sparkle timer: a shiny Mega form with no shiny sheets sparkles instead. */
  sparkT: number;
}

/**
 * A Mega Evolution playing on a player (while the sim holds the pause): a white, rainbow-tinged
 * glow; the energy shell bursts; the sprite swaps with a flash at `SWAP`; then it settles.
 */
interface MegaFx {
  start: number;
  dur: number;
  /** The swap happened (the flash and the banner). */
  swapped: boolean;
}
/** Where in the animation (0–1) the sprite changes form. */
export const MEGA_SWAP = 0.55;

interface EnemyVis {
  anim: Animator;
  flash: number;
  bob: number;
  x: number;
  y: number;
  moving: boolean;
  sparkT: number;
  seen: number;
}

interface Corpse {
  e: NetEnemy;
  anim: Animator;
  fade: number;
}

/** Something drawn in the Y-sorted pass. */
export interface Drawable {
  y: number;
  draw(ctx: CanvasRenderingContext2D): void;
}

export class EntityLayer {
  private players = new Map<string, PlayerVis>();
  private enemies = new Map<number, EnemyVis>();
  private corpses: Corpse[] = [];
  private lost: { anim: Animator; x: number; y: number; flash: number; dex: number } | null = null;
  private rift: { since: number } | null = null;
  private trailT = new Map<number, number>();
  private pickupPhase = new Map<number, number>();
  private frame = 0;

  constructor(
    private readonly fx: FX,
    private readonly camera: Camera,
  ) {}

  private playerVis(p: NetPlayer, frame: Frame): PlayerVis {
    let v = this.players.get(p.id);
    if (!v) {
      const info = frame.game.players.find((x) => x.id === p.id);
      const ref = this.formOf(p.id, frame);
      v = {
        anim: new Animator(ref, 1, info?.shiny ?? false),
        ref,
        flash: 0,
        dead: p.dead,
        deadT: p.dead ? 9 : 0,
        hp: p.hp,
        sparkT: 0,
      };
      if (p.dead) v.anim.play('Faint', { hold: true });
      this.players.set(p.id, v);
    }
    return v;
  }

  /** The sprite a player should show: its Mega form once the snapshots say it evolved. */
  private formOf(id: string, frame: Frame): SpriteRef {
    const dex = frame.game.players.find((x) => x.id === id)?.dex ?? 25;
    const m = frame.snap.details[id]?.mega !== undefined && gameData().megaByDex.get(dex);
    return m ? megaSpriteRef(dex, m.kind) : dex;
  }

  /** Changes a player's sprite (keeping where it faces and what it loops). */
  private swapSprite(id: string, v: PlayerVis, ref: SpriteRef, frame: Frame): void {
    const info = frame.game.players.find((x) => x.id === id);
    const anim = new Animator(ref, 1, info?.shiny ?? false);
    anim.dir = v.anim.dir;
    anim.loop(v.anim.base);
    v.anim = anim;
    v.ref = ref;
  }

  private megas = new Map<string, MegaFx>();

  /**
   * A player Mega Evolved: plays the transformation (`onSwap` at the swap: the flash, the banner
   * and the sound). Without the event (joined later, a lost frame) the sprite just changes.
   */
  onMegaEvolved(playerId: string, onSwap: () => void): void {
    this.megas.set(playerId, {
      start: -1,
      dur: Math.max(0.6, gameData().tuning.mega.animationSeconds),
      swapped: false,
    });
    this.megaSwap.set(playerId, onSwap);
  }
  private megaSwap = new Map<string, () => void>();

  /** 0–1 through a player's Mega Evolution, or null. */
  megaProgress(id: string, time: number): number | null {
    const m = this.megas.get(id);
    return m && m.start >= 0 ? clamp01((time - m.start) / m.dur) : null;
  }

  private enemyVis(e: NetEnemy): EnemyVis {
    let v = this.enemies.get(e.id);
    if (!v) {
      v = {
        anim: new Animator(e.dex, e.scale, e.shiny),
        flash: 0,
        bob: Math.random() * 6,
        x: e.x,
        y: e.y,
        moving: false,
        sparkT: 0,
        seen: 0,
      };
      this.enemies.set(e.id, v);
    }
    return v;
  }

  // ---------------------------------------------------------------- event hooks

  /** A move was cast: plays the attack animation (sped up to fit a short cooldown). */
  onCast(playerId: string, kind: string, moveId: string, frame: Frame): void {
    const p = frame.players.find((x) => x.id === playerId);
    if (!p || kind === 'trail') return;
    const v = this.playerVis(p, frame);
    if (v.anim.busy() && v.anim.progress() < 0.65) return;
    const anim = CAST_ANIM[kind] ?? 'Attack';
    const len = v.anim.length(anim);
    const m = frame.snap.details[playerId]?.moves.find((x) => x.id === moveId);
    const cd = Math.max(
      0.12,
      moveStatsAt(moveId, m?.level ?? 1, m?.evolved ?? false).cooldown ?? 0.5,
    );
    v.anim.play(anim, { speed: Math.max(1, len / (cd * 0.9)) });
  }

  onPlayerHurt(playerId: string): void {
    const v = this.players.get(playerId);
    if (v) v.flash = 0.14;
  }

  onEnemyHurt(id: number): void {
    const v = this.enemies.get(id);
    if (!v) return;
    v.flash = 0.09;
    if (!v.anim.busy()) v.anim.play('Hurt');
  }

  onEnemyAction(id: number, action: string): void {
    const v = this.enemies.get(id);
    const a = ACTION_ANIM[action];
    if (v && a) v.anim.play(a[0], { speed: a[1] });
  }

  /** The enemy fainted: it plays Faint and fades out where it fell. */
  onEnemyDied(id: number, frame: Frame): void {
    const e = frame.enemies.find((x) => x.id === id);
    const v = this.enemies.get(id);
    if (!e || !v) return;
    v.anim.play('Faint', { hold: true });
    this.corpses.push({ e: { ...e }, anim: v.anim, fade: 0.9 });
    this.enemies.delete(id);
  }

  onLostHurt(): void {
    if (this.lost) this.lost.flash = 0.12;
  }

  // ---------------------------------------------------------------- per frame

  update(frame: Frame): void {
    const dt = frame.dt;
    this.frame++;
    for (const p of frame.players) {
      if (p.left) continue;
      const v = this.playerVis(p, frame);
      // Mega Evolution: the sprite changes at the animation's swap, or at once without one.
      const fx = this.megas.get(p.id);
      if (fx && fx.start < 0) fx.start = frame.time;
      const u = this.megaProgress(p.id, frame.time);
      if (fx && u !== null && u >= MEGA_SWAP && !fx.swapped) {
        fx.swapped = true;
        this.megaSwap.get(p.id)?.();
        this.megaSwap.delete(p.id);
      }
      if (fx && u !== null && u >= 1) this.megas.delete(p.id);
      const ref = this.formOf(p.id, frame);
      if (ref !== v.ref && (!fx || fx.swapped)) this.swapSprite(p.id, v, ref, frame);
      v.anim.update(dt);
      if (v.flash > 0) v.flash -= dt;
      if (p.hp < v.hp - 0.5 && !p.dead && p.id !== frame.selfId) v.flash = 0.14;
      v.hp = p.hp;
      if (p.dead && !v.dead) v.anim.play('Faint', { hold: true });
      else if (!p.dead && v.dead) v.anim.loop('Idle');
      v.deadT = p.dead ? v.deadT + dt : 0;
      v.dead = p.dead;
      // A shiny whose form has no shiny sheets: the regular colours, sparkling as shiny.
      const info = frame.game.players.find((x) => x.id === p.id);
      if (info?.shiny && v.ref !== info.dex && !hasShiny(v.ref) && !p.dead) {
        v.sparkT -= dt;
        if (v.sparkT <= 0) {
          v.sparkT = 0.22;
          const h = bodyHeight(v.ref);
          this.fx.twinkle(p.x + rand(-12, 12) * 1.4, p.y - rand(4, h * 1.1));
        }
      }
      if (p.dead) continue;
      // The sim's rule: its target while attacking (a run of casts is one attack), else where it
      // walks. Ours walks as predicted; whether it attacks and at what comes from the server.
      v.anim.dir = stableDir(v.anim.dir, facingOf(p));
      v.anim.loop(p.walking ? 'Walk' : 'Idle');
    }
    const live = new Set<number>();
    for (const e of frame.enemies) {
      live.add(e.id);
      const v = this.enemyVis(e);
      const seen = this.camera.sees(e.x, e.y, 120);
      if (seen) v.anim.update(dt);
      if (v.flash > 0) v.flash -= dt;
      v.bob += dt * 6;
      const speed = dt > 0 ? Math.hypot(e.x - v.x, e.y - v.y) / dt : 0;
      // Moving or not, with some hysteresis (interpolated positions jitter a little).
      v.moving = speed > (v.moving ? 5 : 12);
      v.x = e.x;
      v.y = e.y;
      v.anim.dir = stableDir(v.anim.dir, e.face);
      v.anim.loop(v.moving || e.phase === 'dash' ? 'Walk' : 'Idle', v.moving ? 1.2 : 1);
      if (e.shiny && seen) {
        v.sparkT -= dt;
        if (v.sparkT <= 0) {
          v.sparkT = 0.22;
          const h = bodyHeight(e.dex, e.scale);
          this.fx.twinkle(e.x + rand(-e.r, e.r) * 1.2, e.y - rand(4, h * 1.1));
        }
      }
    }
    // Gone from the snapshot without fainting (out of range, escaped): forget them.
    for (const id of this.enemies.keys()) if (!live.has(id)) this.enemies.delete(id);
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i]!;
      c.anim.update(dt);
      c.fade -= dt;
      if (c.fade <= 0) this.corpses.splice(i, 1);
    }
    for (const id of this.players.keys())
      if (!frame.players.some((p) => p.id === id && !p.left)) this.players.delete(id);
    // Projectile trails.
    for (const pr of frame.projectiles) {
      if (!pr.friendly || !pr.moveId) continue;
      const vis = vfxForMove(pr.moveId, pr.type ?? 'normal');
      if (!vis.trail || !this.camera.sees(pr.x, pr.y, 20)) continue;
      const t = (this.trailT.get(pr.id) ?? 0) - dt;
      if (t <= 0) {
        this.fx.trail(
          vis.trail,
          vis.pal,
          pr.x,
          pr.y - LIFT,
          Math.cos(pr.angle),
          Math.sin(pr.angle),
        );
        this.trailT.set(pr.id, 0.04);
      } else this.trailT.set(pr.id, t);
    }
    if (this.frame % 120 === 0) {
      const ids = new Set(frame.projectiles.map((p) => p.id));
      for (const id of this.trailT.keys()) if (!ids.has(id)) this.trailT.delete(id);
      const pk = new Set(frame.pickups.map((p) => p.id));
      for (const id of this.pickupPhase.keys()) if (!pk.has(id)) this.pickupPhase.delete(id);
    }
    // The lost Pokémon (moves smoothly towards its last known spot).
    const L = frame.snap.misc.lost;
    if (L) {
      if (!this.lost || this.lost.dex !== L.dex)
        this.lost = { anim: new Animator(L.dex), x: L.x, y: L.y, flash: 0, dex: L.dex };
      const lo = this.lost;
      const k = 1 - Math.exp(-12 * dt);
      if (Math.hypot(L.x - lo.x, L.y - lo.y) > 200) {
        lo.x = L.x;
        lo.y = L.y;
      } else {
        lo.x += (L.x - lo.x) * k;
        lo.y += (L.y - lo.y) * k;
      }
      lo.anim.dir = stableDir(lo.anim.dir, L.face);
      lo.anim.loop(L.moving ? 'Walk' : 'Idle');
      lo.anim.update(dt);
      if (lo.flash > 0) lo.flash -= dt;
    } else this.lost = null;
    const r = frame.snap.misc.rift;
    if (r && !this.rift) this.rift = { since: frame.time };
    else if (!r) this.rift = null;
  }

  /** Where a player is drawn (for effects that follow them). */
  playerHeight(frame: Frame, id: string): number {
    const v = this.players.get(id);
    const info = frame.game.players.find((p) => p.id === id);
    return bodyHeight(v?.ref ?? info?.dex ?? 25);
  }

  // ---------------------------------------------------------------- drawing

  /** Ground layer: hazard warnings and fields on the floor. */
  drawGround(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const blink = Math.sin((frame.time * 1000) / 60) > 0;
    for (const h of frame.hazards) this.drawHazard(ctx, h, blink);
    for (const f of frame.fields) this.drawGroundField(ctx, f, frame.time);
  }

  private drawHazard(ctx: CanvasRenderingContext2D, h: NetHazard, blink: boolean): void {
    if (h.hit) return;
    const k = clamp01(h.progress);
    const color = typeColor(h.type || 'normal');
    ctx.save();
    if (h.kind === 'zone') {
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = color;
      ellipse(ctx, h.x, h.y, h.r, h.r * 0.75);
      ctx.fill();
      ctx.globalAlpha = 0.32;
      ellipse(ctx, h.x, h.y, h.r * k, h.r * 0.75 * k);
      ctx.fill();
      ctx.globalAlpha = k > 0.75 && blink ? 0.95 : 0.6;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ellipse(ctx, h.x, h.y, h.r, h.r * 0.75);
      ctx.stroke();
    } else {
      ctx.translate(h.x, h.y);
      ctx.rotate(h.angle);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = color;
      ctx.fillRect(0, -h.w / 2, h.len, h.w);
      ctx.globalAlpha = 0.34;
      ctx.fillRect(0, (-h.w / 2) * k, h.len, h.w * k);
      ctx.globalAlpha = k > 0.75 && blink ? 0.95 : 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(0, -h.w / 2, h.len, h.w);
    }
    ctx.restore();
  }

  private drawGroundField(ctx: CanvasRenderingContext2D, f: NetField, now: number): void {
    if (!this.camera.sees(f.x, f.y, 60)) return;
    const col = typeColor(f.type);
    const vis = vfxForMove(f.moveId, f.type);
    ctx.save();
    if (f.kind === 'patch') {
      const a = Math.min(1, (1 - f.progress) * 6, f.progress * 18 + 0.2);
      ctx.globalAlpha = 0.32 * a;
      ctx.fillStyle = col;
      ellipse(ctx, f.x, f.y, f.r, f.r * 0.62);
      ctx.fill();
      ctx.globalAlpha = 0.5 * a;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ellipse(ctx, f.x, f.y, f.r * 0.8, f.r * 0.5);
      ctx.stroke();
      if (vis.aura && Math.random() < 0.05)
        this.fx.sp(vis.aura, vis.pal, f.x + rand(-f.r, f.r) * 0.6, f.y - 4, { vy: -40, life: 0.4 });
    } else if (f.kind === 'mine') {
      const armed = f.arm <= 0;
      const blink = armed && Math.sin(now * 8 + f.x) > 0.3;
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = col;
      ellipse(ctx, f.x, f.y, f.r * 0.45, f.r * 0.28);
      ctx.fill();
      ctx.globalAlpha = 1;
      drawVfx(ctx, vis.proj, vis.pal, f.x, f.y - 4, { scale: 1, alpha: blink ? 1 : 0.75 });
    } else if (f.kind === 'meteor') {
      // The shadow grows as the rock falls (a volley's later ones wait, small).
      const k = clamp01(f.progress);
      ctx.globalAlpha = 0.2 + k * 0.3;
      ctx.fillStyle = '#000';
      ellipse(ctx, f.x, f.y, f.r * (0.3 + k * 0.7), f.r * 0.6 * (0.3 + k * 0.7));
      ctx.fill();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ellipse(ctx, f.x, f.y, f.r, f.r * 0.6);
      ctx.stroke();
    } else if (f.kind === 'turret') {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#000';
      ellipse(ctx, f.x, f.y, 11, 4.5);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Pickups bobbing on the ground. */
  drawPickups(ctx: CanvasRenderingContext2D, pickups: readonly NetPickup[], now: number): void {
    for (const p of pickups) {
      if (!this.camera.sees(p.x, p.y, 30)) continue;
      const k = PICKUP[p.kind] ?? PICKUP.xp!;
      let ph = this.pickupPhase.get(p.id);
      if (ph === undefined) this.pickupPhase.set(p.id, (ph = Math.random() * 10));
      const t = now * 4 + ph;
      const bounce = Math.abs(Math.sin(t * 0.8)) * 3;
      const r = k.r;
      const y = p.y - 6 - bounce;
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#000';
      ellipse(ctx, p.x, p.y, r * 0.9, r * 0.35);
      ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = k.glow;
      ctx.beginPath();
      ctx.arc(p.x, y, r * 2, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = k.color;
      if (p.kind === 'xp' || p.kind === 'xp-big') {
        ctx.beginPath();
        ctx.moveTo(p.x, y - r);
        ctx.lineTo(p.x + r * 0.78, y);
        ctx.lineTo(p.x, y + r);
        ctx.lineTo(p.x - r * 0.78, y);
        ctx.closePath();
        ctx.fill();
      } else if (p.kind === 'coin') {
        // A spinning coin: an ellipse that narrows.
        const sx = Math.max(0.25, Math.abs(Math.cos(t * 0.9)));
        ellipse(ctx, p.x, y, r * sx, r);
        ctx.fill();
        ctx.fillStyle = '#b8860b';
        ellipse(ctx, p.x, y, r * sx * 0.5, r * 0.5);
        ctx.fill();
      } else {
        const sz = p.kind === 'ticket10' || p.kind === 'item' || p.kind === 'gem' ? 24 : 18;
        if (p.kind === 'gem') {
          // A gem: a pulsing cyan glow, so a rare drop stands out in the crowd.
          ctx.globalAlpha = 0.3 + Math.sin(t * 2) * 0.12;
          ctx.fillStyle = '#5fe3ff';
          ctx.beginPath();
          ctx.arc(p.x, y, 15, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (p.kind === 'item') {
          // A held item: a pulsing golden glow, visible from afar.
          ctx.globalAlpha = 0.35 + Math.sin(t * 1.5) * 0.15;
          ctx.fillStyle = '#ffe14d';
          ctx.beginPath();
          ctx.arc(p.x, y, 18, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        drawIcon(
          ctx,
          p.kind === 'item' ? (p.itemId ?? 'star') : (PICKUP_ICON[p.kind] ?? 'star'),
          p.x - sz / 2,
          y - sz / 2 - 1,
          sz,
        );
        continue;
      }
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      ctx.beginPath();
      ctx.arc(p.x - r * 0.25, y - r * 0.3, r * 0.28, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Everything with feet, for the Y-sorted pass. */
  drawables(frame: Frame): Drawable[] {
    const out: Drawable[] = [];
    for (const c of this.corpses) {
      const alpha = clamp01(c.fade / 0.5);
      out.push({
        y: c.e.y,
        draw: (ctx) => {
          ctx.save();
          ctx.globalAlpha = alpha;
          drawShadow(ctx, c.e.dex, c.e.x, c.e.y, c.e.scale);
          c.anim.draw(ctx, c.e.x, c.e.y, { alpha });
          ctx.restore();
        },
      });
    }
    for (const e of frame.enemies) {
      const v = this.enemies.get(e.id);
      if (!v || !this.camera.sees(e.x, e.y, 120)) continue;
      out.push({ y: e.y, draw: (ctx) => this.drawEnemy(ctx, e, v, frame) });
    }
    for (const p of frame.players) {
      if (p.left) continue;
      const v = this.players.get(p.id);
      if (v) out.push({ y: p.y, draw: (ctx) => this.drawPlayer(ctx, p, v, frame) });
    }
    const rift = frame.snap.misc.rift;
    if (rift && this.rift) {
      const since = frame.time - this.rift.since;
      out.push({ y: rift.y, draw: (ctx) => this.drawRift(ctx, rift, since) });
    }
    const L = frame.snap.misc.lost;
    if (L && this.lost) {
      const lo = this.lost;
      out.push({ y: L.ty - 4000, draw: (ctx) => this.drawLostGoal(ctx, L, frame.time) });
      out.push({ y: lo.y, draw: (ctx) => this.drawLost(ctx, L, lo, frame.time) });
    }
    return out;
  }

  /** Behind the sprite: a rainbow-tinged light that swells, and the shell's shards after it bursts. */
  private drawMegaBack(
    ctx: CanvasRenderingContext2D,
    p: NetPlayer,
    v: PlayerVis,
    u: number,
    time: number,
  ): void {
    const h = bodyHeight(v.ref);
    const cy = p.y - h * 0.5;
    const calm = settings.get().calmMode;
    const glow = u < MEGA_SWAP ? u / MEGA_SWAP : Math.max(0, 1 - (u - MEGA_SWAP) / 0.35);
    if (glow > 0) {
      const tint = MEGA_RAINBOW[Math.floor(time * (calm ? 3 : 9)) % MEGA_RAINBOW.length]!;
      const rad = 18 + h * 0.6 + glow * 26;
      const g = ctx.createRadialGradient(p.x, cy, 2, p.x, cy, rad);
      g.addColorStop(0, `rgba(255,255,255,${0.85 * glow})`);
      g.addColorStop(0.45, `${tint}${alphaHex(0.55 * glow)}`);
      g.addColorStop(1, `${tint}00`);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, cy, rad, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    // Rising motes of every colour while it charges.
    if (u < MEGA_SWAP && !calm) {
      ctx.save();
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * TAU + time * 1.7;
        const rise = (time * 0.9 + i * 0.37) % 1;
        ctx.globalAlpha = (1 - rise) * Math.min(1, u * 4);
        ctx.fillStyle = MEGA_RAINBOW[i % MEGA_RAINBOW.length]!;
        const px = p.x + Math.cos(a) * (14 + h * 0.25);
        ctx.fillRect(Math.round(px), Math.round(p.y - rise * h * 1.4), 3, 3);
      }
      ctx.restore();
    }
  }

  /**
   * In front: the energy shell (a rainbow ring with the Mega symbol over the head) gathering until
   * the swap, when it bursts outwards.
   */
  private drawMegaFront(
    ctx: CanvasRenderingContext2D,
    p: NetPlayer,
    v: PlayerVis,
    u: number,
    time: number,
  ): void {
    const h = bodyHeight(v.ref);
    const cy = p.y - h * 0.5;
    const rad = 12 + h * 0.55;
    ctx.save();
    if (u < MEGA_SWAP) {
      // The shell closes in and spins faster as it charges.
      const k = u / MEGA_SWAP;
      const r = rad * (1.6 - 0.6 * k);
      const spin = time * (2 + k * 8);
      ctx.lineWidth = 3;
      ctx.globalAlpha = Math.min(1, k * 2.5);
      MEGA_RAINBOW.forEach((c, i) => {
        const a0 = spin + (i / MEGA_RAINBOW.length) * TAU;
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.ellipse(p.x, cy, r, r * 0.9, 0, a0, a0 + TAU / MEGA_RAINBOW.length - 0.08);
        ctx.stroke();
      });
      // The Mega symbol over the head, growing in.
      const size = 24 * (0.5 + 0.5 * Math.min(1, k * 1.6));
      drawIcon(ctx, 'mega', p.x - size / 2, p.y - h - size - 6, size);
    } else {
      // The shell bursts: shards of each colour flying out, fading.
      const k = (u - MEGA_SWAP) / (1 - MEGA_SWAP);
      ctx.globalAlpha = Math.max(0, 1 - k * 1.3);
      MEGA_RAINBOW.forEach((c, i) => {
        const a = (i / MEGA_RAINBOW.length) * TAU + 0.4;
        const d = rad + k * 110;
        ctx.fillStyle = c;
        const x = p.x + Math.cos(a) * d;
        const y = cy + Math.sin(a) * d * 0.8;
        ctx.fillRect(Math.round(x - 3), Math.round(y - 3), 6, 6);
      });
      // The symbol rises and fades.
      drawIcon(ctx, 'mega', p.x - 12, p.y - h - 30 - k * 18, 24);
    }
    ctx.restore();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, p: NetPlayer, v: PlayerVis, frame: Frame) {
    const detail: PlayerDetail | undefined = frame.snap.details[p.id];
    const info = frame.game.players.find((x) => x.id === p.id);
    const dex = v.ref;
    const r = 12;
    const offline = !p.connected;
    // The active move's type halo on the ground.
    const activeId = detail?.slots[p.active]?.[0];
    const m = detail?.moves.find((x) => x.id === activeId);
    if (m && !p.dead) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = typeColor(m.type);
      ctx.lineWidth = 2;
      ellipse(ctx, p.x, p.y, r * 1.5, r * 0.6);
      ctx.stroke();
      ctx.restore();
    }
    drawShadow(ctx, dex, p.x, p.y);
    // Altar power: a ring of its colour pulsing under the feet.
    if (detail?.power && !p.dead) {
      ctx.save();
      ctx.globalAlpha = 0.35 + Math.sin(frame.time * 8.3) * 0.15;
      ctx.strokeStyle = altarPower(detail.power.id).color;
      ctx.lineWidth = 3;
      ellipse(ctx, p.x, p.y, r * 2.1, r * 0.85);
      ctx.stroke();
      ctx.restore();
    }
    const blinkAlpha =
      p.invulnerable && !p.dead && p.connected ? (Math.floor(frame.time * 18) % 2 ? 0.45 : 1) : 1;
    // A form without Faint holds Hurt instead and fades a little (still there to revive).
    const faded = p.dead && !hasAnim(v.ref, 'Faint') ? Math.max(0.45, 1 - v.deadT * 0.8) : 1;
    const mega = this.megaProgress(p.id, frame.time);
    if (mega !== null) this.drawMegaBack(ctx, p, v, mega, frame.time);
    v.anim.draw(ctx, p.x, p.y, {
      flash: v.flash > 0,
      softFlash: true,
      alpha: (offline ? 0.4 : blinkAlpha) * faded,
      color: PLAYER_COLORS[p.index] ?? '#ffcb3d',
    });
    if (mega !== null) {
      // Glowing white: the sprite again, all white, over itself.
      const white = megaWhite(mega);
      if (white > 0) v.anim.draw(ctx, p.x, p.y, { flash: true, alpha: white });
      this.drawMegaFront(ctx, p, v, mega, frame.time);
    }
    // Buff arcs around the feet.
    let i = 0;
    for (const [k, n] of (detail?.buffs ?? [0, 0, 0, 0]).entries()) {
      if (n <= 0) continue;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = BUFF_COLORS[k] ?? '#fff';
      ctx.lineWidth = 2;
      const rr = r * 1.8 + i * 5;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rr, rr * 0.42, 0, 0, TAU * Math.min(1, n / 5));
      ctx.stroke();
      ctx.restore();
      i++;
    }
    // Being revived: a ring filling up.
    if (p.dead && p.reviveT > 0) {
      ctx.save();
      ctx.strokeStyle = '#5fe08a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(
        p.x,
        p.y,
        r * 2.4,
        r,
        0,
        -Math.PI / 2,
        -Math.PI / 2 + TAU * Math.min(1, p.reviveT / REVIVE_SECONDS),
      );
      ctx.stroke();
      ctx.restore();
    }
    // Group play: a name tag over teammates.
    if (frame.game.players.length > 1 && p.id !== frame.selfId) {
      const name = info?.username ?? '';
      ctx.save();
      ctx.font = '700 7px Pixelify,"Segoe UI",sans-serif';
      ctx.textAlign = 'center';
      const y = p.y - bodyHeight(dex) - 8;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.strokeText(name, p.x, y);
      ctx.fillStyle = p.dead ? '#ff8a96' : offline ? '#9aa2ae' : (PLAYER_COLORS[p.index] ?? '#fff');
      ctx.fillText(name, p.x, y);
      // Their Pokémon's prestige stars, in gold after the name.
      if (info?.prestige) {
        const stars = '★'.repeat(info.prestige);
        const sx = p.x + ctx.measureText(name).width / 2 + 1.5;
        ctx.textAlign = 'left';
        ctx.strokeText(stars, sx, y);
        ctx.fillStyle = '#ffd65c';
        ctx.fillText(stars, sx, y);
      }
      ctx.restore();
    }
  }

  private drawEnemy(ctx: CanvasRenderingContext2D, e: NetEnemy, v: EnemyVis, frame: Frame) {
    const gold = e.golden || e.behavior === 'thief' || frame.snap.misc.event?.id === 'gold';
    const h = bodyHeight(e.dex, e.scale);
    if (e.boss || e.shiny || gold) {
      ctx.save();
      ctx.globalAlpha = (gold && !e.boss ? 0.32 : 0.22) + Math.sin(v.bob * 0.5) * 0.06;
      ctx.fillStyle = e.fury
        ? '#ff4a4a'
        : e.shiny
          ? '#9ae6ff'
          : e.wildLegend
            ? '#c9a6ff'
            : gold
              ? '#ffd23f'
              : '#ffd95e';
      ellipse(ctx, e.x, e.y, e.r * 1.6, e.r * 0.6);
      ctx.fill();
      ctx.restore();
    }
    drawShadow(ctx, e.dex, e.x, e.y, e.scale);
    // Hovering ones already float in their sprite: they only sway a little. Jumpers arc.
    const lift =
      (e.flying && !e.boss ? 1 + Math.sin(v.bob) * 1.5 : 0) +
      (e.jump !== null ? Math.sin(e.jump * Math.PI) * 46 : 0);
    v.anim.draw(ctx, e.x, e.y - lift, { flash: v.flash > 0 });
    if (e.shielded) {
      ctx.save();
      ctx.globalAlpha = 0.35 + Math.sin(v.bob) * 0.08;
      ctx.strokeStyle = '#9fd8ff';
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(127,200,255,.14)';
      ellipse(ctx, e.x, e.y - h * 0.45, e.r * 1.5, h * 0.65);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    if (e.burning || e.poisoned) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = e.burning ? '#ff8a3d' : '#c86bdc';
      ellipse(ctx, e.x, e.y, e.r * 1.2, e.r * 0.5);
      ctx.fill();
      ctx.restore();
    }
    // Supports get an icon on top, so you know whom to go for first.
    const icon = SUPPORT_ICON[e.behavior];
    if (icon)
      drawIcon(
        ctx,
        icon,
        Math.round(e.x - 6),
        Math.round(e.y - h - (e.shielded ? 31 : e.hp < e.maxHp || e.boss ? 26 : 18)),
        12,
      );
    if (e.boss || e.hp < e.maxHp || e.shielded) {
      const w = e.boss ? 90 : Math.max(22, e.r * 2);
      const y = e.y - h - 10;
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(e.x - w / 2, y, w, 3.4);
      ctx.fillStyle = e.wildLegend ? '#b48aff' : e.boss ? '#ffcb3d' : '#ff5f6d';
      ctx.fillRect(e.x - w / 2, y, w * clamp01(e.hp / Math.max(1, e.maxHp)), 3.4);
      if (e.shielded) {
        // Same scale as HP: the blue segment shows the actual extra health, including at full HP.
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.fillRect(e.x - w / 2, y - 5, w, 3.4);
        ctx.fillStyle = '#9fd8ff';
        ctx.fillRect(e.x - w / 2, y - 5, w * clamp01(e.shield / Math.max(1, e.maxHp)), 3.4);
      }
    }
  }

  private drawRift(
    ctx: CanvasRenderingContext2D,
    rift: NonNullable<NetMisc['rift']>,
    since: number,
  ) {
    const img = propSprite(0, 'rift', Math.floor(since * 8) % 4);
    const w = img.width * PX;
    const h = img.height * PX;
    const fadeIn = Math.min(1, since * 2);
    const fadeOut = Math.min(1, (rift.ttl + 0.5) / 1.5);
    ctx.save();
    ctx.globalAlpha = 0.25 * fadeIn * fadeOut;
    ctx.fillStyle = '#7b3cff';
    ellipse(ctx, rift.x, rift.y, 34, 12);
    ctx.fill();
    ctx.globalAlpha = fadeIn * fadeOut;
    ctx.drawImage(img, Math.round(rift.x - w / 2), Math.round(rift.y - h + 4), w, h);
    ctx.restore();
    if (Math.random() < 0.3)
      this.fx.px(rift.x + rand(-14, 14), rift.y - rand(10, 80), '#d9c2ff', { vy: -40, life: 0.6 });
  }

  private drawLostGoal(
    ctx: CanvasRenderingContext2D,
    L: NonNullable<NetMisc['lost']>,
    now: number,
  ) {
    const k = 0.5 + Math.sin(now * 4) * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.25 + k * 0.15;
    ctx.fillStyle = '#5fe08a';
    ellipse(ctx, L.tx, L.ty, 56, 40);
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#7dffb0';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ellipse(ctx, L.tx, L.ty, 56, 40);
    ctx.stroke();
    ctx.restore();
    drawIcon(ctx, 'heart', Math.round(L.tx - 8), Math.round(L.ty - 30 - k * 6), 16);
  }

  private drawLost(
    ctx: CanvasRenderingContext2D,
    L: NonNullable<NetMisc['lost']>,
    lo: NonNullable<EntityLayer['lost']>,
    now: number,
  ) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#7dffb0';
    ellipse(ctx, lo.x, lo.y, L.r * 1.5, L.r * 0.6);
    ctx.fill();
    ctx.restore();
    drawShadow(ctx, L.dex, lo.x, lo.y);
    lo.anim.draw(ctx, lo.x, lo.y, { flash: lo.flash > 0 });
    const h = bodyHeight(L.dex);
    if (L.phase === 'wait') {
      // A bouncing "!": it's waiting for you to touch it.
      const by = lo.y - h - 14 - Math.abs(Math.sin(now * 5)) * 6;
      ctx.save();
      ctx.font = '700 16px Pixelify, monospace';
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#000';
      ctx.strokeText('!', lo.x, by);
      ctx.fillStyle = '#7dffb0';
      ctx.fillText('!', lo.x, by);
      ctx.restore();
    }
    const w = 30;
    const y = lo.y - h - 6;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(lo.x - w / 2, y, w, 3.4);
    ctx.fillStyle = '#5fe08a';
    ctx.fillRect(lo.x - w / 2, y, w * clamp01(L.hp / Math.max(1, L.maxHp)), 3.4);
  }

  /**
   * Follows the shots between frames: when each was first seen (its age, for the fade at the end
   * of its life), and where friendly ones were last, to burst where they hit something.
   */
  private shots = new Map<
    number,
    { born: number; x: number; y: number; type: string; seen: number }
  >();

  /** Projectiles' ages and their bursts (call once per frame, before drawing). */
  trackShots(frame: Frame, blocked: (x: number, y: number) => boolean): void {
    const now = frame.time;
    for (const p of frame.projectiles) {
      const s = this.shots.get(p.id);
      if (s) {
        s.x = p.x;
        s.y = p.y;
        s.seen = now;
      } else if (p.friendly && !p.orb)
        this.shots.set(p.id, { born: now, x: p.x, y: p.y, type: p.type ?? 'normal', seen: now });
      else this.shots.set(p.id, { born: now, x: p.x, y: p.y, type: '', seen: now });
    }
    for (const [id, s] of this.shots) {
      if (s.seen === now) continue;
      this.shots.delete(id);
      // A friendly shot that stopped on an enemy or a wall bursts there (original implementation);
      // one that just ran out of life or range fades.
      if (!s.type || !this.camera.sees(s.x, s.y, 20)) continue;
      const hit =
        blocked(s.x, s.y) ||
        frame.enemies.some((e) => (e.x - s.x) ** 2 + (e.y - s.y) ** 2 < (e.r + 14) ** 2);
      if (hit) this.fx.burst(s.x, s.y - LIFT, typeColor(s.type), 5, 80);
    }
  }

  /** Shots in flight (above the sorted pass), with their shadows. */
  drawProjectiles(ctx: CanvasRenderingContext2D, frame: Frame) {
    const list = frame.projectiles;
    const now = frame.time;
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    for (const p of list) {
      if (!this.camera.sees(p.x, p.y, 40)) continue;
      ellipse(ctx, p.x, p.y, p.r * 0.9, p.r * 0.38);
      ctx.fill();
    }
    // Enemy shots get a red ring on the ground: "this hurts you".
    ctx.fillStyle = 'rgba(255,60,80,.35)';
    for (const p of list) {
      if (p.friendly || !this.camera.sees(p.x, p.y, 40)) continue;
      ellipse(ctx, p.x, p.y, p.r * 1.5, p.r * 0.6);
      ctx.fill();
    }
    for (const p of list) {
      if (!this.camera.sees(p.x, p.y, 40)) continue;
      const v =
        p.friendly && p.moveId
          ? vfxForMove(p.moveId, p.type ?? 'normal')
          : vfxForType(p.type ?? 'normal');
      const shape = v.proj;
      const age = now - (this.shots.get(p.id)?.born ?? now);
      let angle = 0;
      if (vfxIsDir(shape)) {
        // Orbs face along their circle (legacy: orbit angle + 90°); shots along their flight.
        const owner = p.orb ? frame.players.find((q) => q.index === p.ownerIndex) : undefined;
        angle = owner ? Math.atan2((p.y - owner.y) / 0.7, p.x - owner.x) + Math.PI / 2 : p.angle;
      } else if (vfxSpins(shape)) angle = age * 9 + p.id;
      drawVfx(ctx, shape, v.pal, p.x, p.y - LIFT, {
        angle,
        alpha: this.shotAlpha(p, age, frame),
        scale: p.r >= 8 ? 1.5 : 1,
        frame: Math.floor(age * 12 + p.id),
      });
    }
  }

  /** Shots fade over the last quarter second of their life (original implementation). */
  private shotAlpha(p: NetProjectile, age: number, frame: Frame): number {
    if (p.orb || !p.friendly || !p.moveId || p.returning) return 1;
    const owner = frame.game.players.find((q) => q.index === p.ownerIndex);
    const m = owner
      ? frame.snap.details[owner.id]?.moves.find((x) => x.id === p.moveId)
      : undefined;
    const life = moveStatsAt(p.moveId, m?.level ?? 1, m?.evolved ?? false).lifetime;
    return life ? clamp01((life - age) * 4) : 1;
  }

  /** Falling meteors and turrets (above everything on the ground). */
  drawAirFields(ctx: CanvasRenderingContext2D, fields: readonly NetField[], now: number) {
    for (const f of fields) {
      if (!this.camera.sees(f.x, f.y, 200)) continue;
      const vis = vfxForMove(f.moveId, f.type);
      if (f.kind === 'meteor') {
        // Falls from up and to the right onto its shadow (original implementation `drawAirFields`).
        if (f.progress <= 0) continue;
        const k = clamp01(f.progress);
        drawVfx(ctx, vis.proj, vis.pal, f.x + (1 - k) * 40, f.y - (1 - k) * 170 - 6, {
          scale: 1.5,
          angle: Math.atan2(170, -40),
          frame: Math.floor(now * 12),
        });
      } else if (f.kind === 'turret') {
        const fade = Math.min(1, (1 - f.progress) * 12, f.progress * 30 + 0.2);
        const bob = Math.sin(now * 4 + f.x) * 2;
        drawVfx(ctx, vis.proj, vis.pal, f.x, f.y - 16 + bob, {
          scale: 1.5,
          alpha: fade,
          frame: Math.floor(now * 8),
        });
      }
    }
  }
}

/** A Pokémon's display name. */
export function pokemonName(dex: number): string {
  return loadGameData().pokemonByDex.get(dex)?.name ?? `#${dex}`;
}
