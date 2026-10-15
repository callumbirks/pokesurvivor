// Sim events → what you see and hear: effects, damage numbers, sounds, screen shake, animations
// and banners (what legacy did inline in combat.js, enemy.js, game.js `onCollect`, …). Events are
// cosmetic; the state in the snapshots is the truth.
import { t, type UiStringKey } from '@pokesurvivor/data';
import { gameData } from '../live-config.js';
import type { SimEvent } from '@pokesurvivor/sim';
import { moveStatsAt } from '@pokesurvivor/sim';
import { audio, type SfxName } from '../audio.js';
import { typeColor } from '../icons.js';
import { bodyHeight } from '../sprites.js';
import type { Frame } from './frame.js';
import type { Camera } from './scene/camera.js';
import { LIFT, type EntityLayer, pokemonName } from './scene/entities.js';
import type { FX } from './scene/fx.js';
import { vfxForMove, vfxForType, vfxSpins } from './scene/vfx.js';
import type { WorldRenderer } from './scene/world.js';

/** Families that sound like an older one (original implementation). */
const SHOT_SOUND: Record<string, string> = {
  boomerang: 'projectile',
  chain: 'beam',
  mine: 'nova',
  meteor: 'nova',
  turret: 'buff',
  dash: 'melee',
  trail: 'aura',
  cone: 'projectile',
};
const PICK_SFX: Record<string, SfxName> = {
  xp: 'xp',
  'xp-big': 'xp',
  coin: 'coin',
  heal: 'heal',
  bomb: 'break',
  magnet: 'confirm',
  ticket: 'shiny',
  ticket10: 'legend',
  item: 'legend',
};
const TRAP_COLORS: Record<string, string> = {
  poison: '#b45ec4',
  sticky: '#8bd94a',
  explosive: '#ff7b3d',
};
const PROP_DEBRIS: Record<string, string> = {
  grass: '#4c9a3f',
  rock: '#9aa2ae',
  chest: '#f2c443',
  tree: '#2f7535',
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export interface EventSinks {
  fx: FX;
  camera: Camera;
  entities: EntityLayer;
  world: WorldRenderer;
  /** A banner (latest wins). */
  say(text: string, seconds: number): void;
  /** A white (or coloured) full-screen flash. */
  flash(color: string, seconds: number): void;
  /** A softer glow around the screen's edges (our own revive). */
  glow(color: string, seconds: number): void;
  /** Does the player already own this Pokémon (for rescues)? */
  owns(dex: number): boolean | null;
}

type EnemyHurt = Extract<SimEvent, { type: 'enemy-hurt' }>;

/**
 * A damage number's colour (original implementation `showHurt`): shield blue when the shield took it all;
 * crit orange, super-effective yellow, not-very-effective grey; otherwise the attack's type colour
 * (white when untyped, or from a server that doesn't send it).
 */
export function hurtColor(e: Pick<EnemyHurt, 'shielded' | 'label'> & { moveType?: string | null }) {
  if (e.shielded) return '#9fd8ff';
  if (e.label === 'crit') return '#ff9a3c';
  if (e.label === 'super') return '#ffe14d';
  if (e.label === 'weak') return '#a3abb8';
  return e.moveType ? typeColor(e.moveType) : '#ffffff';
}

export class EventEffects {
  constructor(private readonly k: EventSinks) {}

  /** Fields seen recently: a field leaves the snapshot in the frame its blast event plays. */
  private fields = new Map<number, { kind: string; type: string; seen: number }>();

  /** Remembers the frame's fields (call every frame, before `play`). */
  trackFields(frame: Frame): void {
    for (const f of frame.fields)
      this.fields.set(f.id, { kind: f.kind, type: f.type, seen: frame.time });
    if (this.fields.size > 200)
      for (const [id, f] of this.fields) if (frame.time - f.seen > 5) this.fields.delete(id);
  }

  /** Plays the events of one snapshot, as the rendered view reaches it. */
  play(events: readonly SimEvent[], frame: Frame): void {
    for (const e of events) {
      try {
        this.one(e, frame);
      } catch (err) {
        // A cosmetic glitch must never break the game.
        console.error('[game] event', e.type, err);
      }
    }
  }

  private sfx(name: SfxName, opts?: Parameters<typeof audio.sfx>[1]): void {
    audio.sfx(name, opts);
  }

  private near(frame: Frame, x: number, y: number, pad = 60): boolean {
    return this.k.camera.sees(x, y, pad) || !frame.self;
  }

  private one(e: SimEvent, frame: Frame): void {
    const { fx, camera, entities } = this.k;
    const self = frame.self;
    const mine = (id: string | null | undefined) => id === frame.selfId;
    switch (e.type) {
      case 'say': {
        if (e.playerId && !mine(e.playerId)) return;
        // Teammates leaving get a toast (with their name) instead.
        if (e.key === 'hud.leftTheGame') return;
        // The sim names players by id: show their username.
        const params = e.params
          ? Object.fromEntries(
              Object.entries(e.params).map(([k, v]) => [
                k,
                frame.game.players.find((p) => p.id === v)?.username ?? v,
              ]),
            )
          : undefined;
        this.k.say(t(e.key, params), e.seconds);
        return;
      }
      case 'cast': {
        // Our own casts start from where we're drawn (predicted), not where the server saw us.
        const x = mine(e.playerId) && self ? self.x : e.x;
        const y = mine(e.playerId) && self ? self.y : e.y;
        entities.onCast(e.playerId, e.kind, e.moveId, frame);
        if (!this.near(frame, x, y, 120)) return;
        if (e.kind !== 'trail')
          this.sfx('shot', { kind: SHOT_SOUND[e.kind] ?? e.kind, type: e.moveType });
        this.castVisuals(e, x, y, frame, 12);
        return;
      }
      case 'slot':
        if (mine(e.playerId)) this.sfx('click');
        return;
      case 'slot-locked':
        if (mine(e.playerId)) this.sfx('error');
        return;
      case 'enemy-hurt': {
        const en = frame.enemies.find((x) => x.id === e.id);
        const h = en ? bodyHeight(en.dex, en.scale) : 24;
        const big = !!en?.boss || e.label === 'super' || e.label === 'crit';
        fx.text(e.x, e.y - h - 4, Math.round(e.amount), hurtColor(e), big);
        if (!e.shielded) {
          const dx = self ? e.x - self.x : 0;
          const dy = self ? e.y - self.y : 0;
          fx.spark(e.x, e.y - h * 0.5, e.moveType ? typeColor(e.moveType) : '#ffffff', dx, dy, 3);
          entities.onEnemyHurt(e.id);
          if (this.near(frame, e.x, e.y)) this.sfx('hit');
        }
        return;
      }
      case 'enemy-healed': {
        const en = frame.enemies.find((x) => x.id === e.id);
        const h = en ? bodyHeight(en.dex, en.scale) : 24;
        const r = en?.r ?? 12;
        fx.ring(e.x, e.y - h * 0.4, r * 0.4, r * 1.8, '#5fe08a', 0.4, 2);
        fx.burst(e.x, e.y - h * 0.5, '#7dffb0', 5, 60);
        if (e.amount >= 1) fx.text(e.x, e.y - h - 4, `+${Math.round(e.amount)}`, '#5fe08a');
        return;
      }
      case 'enemy-died': {
        const en = frame.enemies.find((x) => x.id === e.id);
        const r = en?.r ?? 12;
        const h = en ? bodyHeight(en.dex, en.scale) : 24;
        const col = e.boss ? '#ffd95e' : '#ffffff';
        const cy = e.y - h * 0.5;
        fx.burst(e.x, cy, col, e.boss ? 34 : 9, e.boss ? 260 : 120);
        fx.ring(e.x, e.y, r, r * (e.boss ? 6 : 2.6), col, e.boss ? 0.6 : 0.3, e.boss ? 6 : 3);
        if (e.boss) camera.kick(0.9);
        if (e.shiny) {
          fx.burst(e.x, cy, '#ffe9a0', 30, 220);
          fx.ring(e.x, e.y, r, r * 7, '#9ae6ff', 0.7, 5);
        }
        if (en?.behavior === 'thief') fx.ring(e.x, e.y, r, r * 5, '#ffd23f', 0.6, 4);
        entities.onEnemyDied(e.id, frame);
        if (this.near(frame, e.x, e.y)) this.sfx(e.boss ? 'bossDown' : 'faint');
        return;
      }
      case 'enemy-spawned':
        if (e.legend) this.sfx('legend');
        else if (e.boss) this.sfx('boss');
        else if (e.shiny) this.sfx('shiny');
        return;
      case 'enemy-action': {
        entities.onEnemyAction(e.id, e.action);
        const en = frame.enemies.find((x) => x.id === e.id);
        if (!en) return;
        if (e.action === 'enrage') {
          fx.ring(en.x, en.y, en.r, en.r * 5, '#ff4a4a', 0.6, 5);
          this.sfx('boss');
        } else if (e.action === 'heal') {
          fx.ring(en.x, en.y, 8, gameData().tuning.enemyHeals.radius, '#5fe08a', 0.5, 3);
          if (this.near(frame, en.x, en.y, 0)) this.sfx('heal');
        } else if (e.action === 'shield') fx.ring(en.x, en.y, 8, 160, '#7fc8ff', 0.5, 3);
        else if (e.action === 'summon') fx.ring(en.x, en.y, 8, 50, '#c47bff', 0.4, 3);
        else if (e.action === 'charge') fx.ring(en.x, en.y, en.r, en.r * 2.4, '#ff6b6b', 0.25, 2);
        else if (e.action === 'shoot') fx.ring(en.x, en.y - LIFT, 4, 14, '#ff7a9e', 0.2, 2);
        else if (e.action === 'land') {
          fx.ring(en.x, en.y, en.r, en.r * 3, '#e8dcc0', 0.35, 3);
          if (this.near(frame, en.x, en.y, 0)) camera.kick(0.25);
        }
        return;
      }
      case 'hazard': {
        if (e.phase !== 'hit') return;
        const h = frame.hazards.find((x) => x.id === e.id);
        if (!h) return;
        const near = this.near(frame, h.x, h.y, 80);
        const color = typeColor(h.type || 'normal');
        if (h.kind === 'zone') {
          fx.ring(h.x, h.y, 4, h.r, color, 0.35, 4);
          fx.burst(h.x, h.y - 6, color, 12, 160);
          if (near) {
            this.sfx('break');
            if (h.r > 60) camera.kick(0.35);
          }
        } else {
          fx.beam(h.x, h.y - LIFT, h.angle, h.len, h.w, vfxForType(h.type || 'normal'));
          if (near) this.sfx('shot', { kind: 'beam', type: h.type });
        }
        return;
      }
      case 'player-hurt': {
        const p = frame.players.find((x) => x.id === e.playerId);
        if (!p) return;
        const h = entities.playerHeight(frame, p.id);
        const color = e.label === 'super' ? '#ff3048' : e.label === 'weak' ? '#c9a0a8' : '#ff6b7a';
        fx.text(p.x, p.y - h - 4, `-${Math.round(e.amount)}`, color, e.label === 'super');
        fx.burst(p.x, p.y - h * 0.5, '#ff5f6d', 6, 90);
        entities.onPlayerHurt(p.id);
        if (mine(e.playerId)) {
          this.sfx('hurt');
          camera.kick(0.28);
        }
        return;
      }
      case 'player-healed': {
        const p = frame.players.find((x) => x.id === e.playerId);
        if (p && e.amount >= 1 && mine(e.playerId))
          fx.text(
            p.x,
            p.y - entities.playerHeight(frame, p.id) - 4,
            `+${Math.round(e.amount)}`,
            '#5fe08a',
          );
        return;
      }
      case 'player-down':
        if (mine(e.playerId)) this.sfx('faint');
        return;
      case 'player-revived': {
        const p = frame.players.find((x) => x.id === e.playerId);
        if (!p) return;
        const h = entities.playerHeight(frame, p.id);
        if (mine(e.playerId)) {
          // Our own revive is easy to miss in the crowd: a bigger double ring, more sparks, a green
          // glow around the screen and its own sound (MateAlerts adds the banner).
          fx.ring(p.x, p.y, 8, 120, '#5fe08a', 0.7, 6);
          fx.ring(p.x, p.y, 4, 80, '#c8ffd6', 0.5, 3);
          fx.burst(p.x, p.y - h * 0.5, '#9dffb8', 36, 220);
          this.k.glow('#5fe08a', 1.2);
          this.sfx('revived');
          return;
        }
        fx.ring(p.x, p.y, 6, 70, '#5fe08a', 0.5, 4);
        fx.burst(p.x, p.y - h * 0.5, '#9dffb8', 18, 150);
        this.sfx('heal');
        return;
      }
      case 'focus-sash': {
        const p = frame.players.find((x) => x.id === e.playerId);
        if (!p) return;
        fx.text(
          p.x,
          p.y - entities.playerHeight(frame, p.id) - 16,
          t('items.focusSash'),
          '#ff9a3d',
          true,
        );
        fx.ring(p.x, p.y, 6, 70, '#ff9a3d', 0.5, 4);
        return;
      }
      case 'pickup': {
        const p = frame.players.find((x) => x.id === e.playerId);
        const own = mine(e.playerId);
        if (own || e.kind === 'bomb') {
          const s = PICK_SFX[e.kind];
          if (s) this.sfx(s);
        }
        if (!p) return;
        const h = entities.playerHeight(frame, p.id);
        if (e.kind === 'coin') fx.text(p.x, p.y - h - 6, `+${e.value}`, '#ffd23f');
        else if (e.kind === 'ticket' || e.kind === 'ticket10') {
          const one = e.kind === 'ticket';
          fx.text(
            p.x,
            p.y - h - 8,
            one ? t('hud.n1Ticket') : t('hud.ticketX10'),
            one ? '#ffd23f' : '#d9a6ff',
            true,
          );
          fx.ring(p.x, p.y, 6, 50, one ? '#ffd23f' : '#c47bff', 0.4, 3);
        } else if (e.kind === 'heal') fx.ring(p.x, p.y, 6, 60, '#5fe08a', 0.4, 3);
        return;
      }
      case 'magnet': {
        const p = frame.players.find((x) => x.id === e.playerId);
        if (p) fx.ring(p.x, p.y, 10, 420, '#ff9ed8', 0.6, 4);
        return;
      }
      case 'bomb':
        if (self && Math.hypot(e.x - self.x, e.y - self.y) < 500) camera.kick(0.8);
        fx.ring(e.x, e.y, 20, camera.outerRadius(), '#ff7b3d', 0.5, 6);
        return;
      case 'prop-hit':
        this.k.world.flashProp(e.key);
        return;
      case 'prop-broken': {
        const col = PROP_DEBRIS[e.propType] ?? '#c9b28a';
        fx.burst(e.x, e.y - 10, col, e.propType === 'grass' ? 6 : 12, 120);
        if (!this.near(frame, e.x, e.y)) return;
        if (e.propType === 'grass') this.sfx('grass');
        else if (e.propType === 'chest' || e.propType === 'big-chest') {
          this.sfx('chest');
          camera.kick(0.4);
        } else this.sfx('break');
        return;
      }
      case 'field-blast': {
        // A meteor landing, a mine going off, or a trail pool's tick (original implementation).
        const f = this.fields.get(e.id) ?? frame.fields.find((x) => x.id === e.id);
        const col = typeColor(f?.type ?? 'normal');
        if (f?.kind === 'patch') return; // pools hurt every half second without a flash
        const meteor = f?.kind === 'meteor';
        fx.ring(e.x, e.y, 4, e.r, col, meteor ? 0.35 : 0.3, 4);
        fx.burst(e.x, e.y - 6, col, meteor ? 12 : 10, meteor ? 170 : 150);
        if (this.near(frame, e.x, e.y, 40)) {
          this.sfx('break');
          if (meteor) camera.kick(0.12);
        }
        return;
      }
      case 'biome': {
        this.sfx('biome');
        this.k.say(`— ${this.k.world.biomeName} —`, 3);
        if (self) fx.ring(self.x, self.y, 10, camera.outerRadius(), '#ffffff', 0.7, 6);
        return;
      }
      case 'level-up':
        this.sfx('levelup');
        return;
      case 'move-evolved': {
        const p = frame.players.find((x) => x.id === e.playerId);
        if (!p) return;
        fx.ring(p.x, p.y, 8, 120, '#ffd23f', 0.8, 6);
        fx.burst(p.x, p.y - entities.playerHeight(frame, p.id) * 0.5, '#ffe14d', 40, 240);
        if (mine(e.playerId)) this.sfx('legend');
        return;
      }
      case 'move-learned':
      case 'move-upgraded':
        if (mine(e.playerId)) this.sfx('confirm');
        return;
      case 'shiny-caught':
        this.sfx('shinyGet');
        return;
      case 'rift-opened':
        this.sfx('rift');
        return;
      case 'arena-entered':
        this.k.flash('#ffffff', 0.8);
        this.sfx('rift');
        return;
      case 'arena-ended':
        this.sfx(e.result === 'won' ? 'legend' : 'gameover');
        return;
      case 'arena-left':
        this.k.flash('#d9c2ff', 0.6);
        return;
      case 'bond-formed': {
        const p = frame.players.find((x) => x.id === e.playerId);
        if (!p) return;
        fx.ring(p.x, p.y, 8, 130, '#ff8ad8', 0.8, 6);
        fx.burst(p.x, p.y - entities.playerHeight(frame, p.id) * 0.5, '#ffb3e6', 40, 240);
        if (mine(e.playerId)) this.sfx('legend');
        return;
      }
      case 'run-event':
        if (e.phase === 'start') this.sfx('surge');
        return;
      case 'thief':
        this.sfx('shiny');
        return;
      case 'lost-pokemon':
        if (e.phase === 'hurt') entities.onLostHurt();
        if (e.phase === 'found' && mine(e.playerId)) this.sfx('confirm');
        if (e.phase === 'rescued') {
          this.sfx('shinyGet');
          if (e.joins) {
            const owned = this.k.owns(e.dex);
            const name = pokemonName(e.dex);
            const key: UiStringKey = owned ? 'hud.thanksYou150CoinsYou' : 'hud.joinsYourTeam';
            if (owned !== null) this.k.say(t(key, { 0: name }), 4);
          } else this.k.say(t('hud.youBroughtHomeItThanks', { 0: pokemonName(e.dex) }), 4);
        }
        if (e.phase === 'scared')
          this.k.say(t('hud.gotScaredAndRanAway', { 0: pokemonName(e.dex) }), 3);
        if (e.phase === 'tired')
          this.k.say(t('hud.gotTiredOfWaitingAnd', { 0: pokemonName(e.dex) }), 3);
        return;
      case 'altar': {
        const p = frame.players.find((x) => x.id === e.playerId);
        if (p) fx.ring(p.x, p.y, 8, 90, '#ffd23f', 0.6, 4);
        if (mine(e.playerId)) this.sfx('legend');
        return;
      }
      case 'trap': {
        const col = TRAP_COLORS[e.trap] ?? '#ff7b3d';
        fx.ring(e.x, e.y, 6, e.r, col, 0.45, 4);
        fx.burst(e.x, e.y - 6, col, 14, 160);
        if (this.near(frame, e.x, e.y)) {
          this.sfx('break');
          if (e.trap === 'explosive') camera.kick(0.35);
        }
        return;
      }
      case 'run-ended':
        this.sfx('gameover');
        return;
      default:
        return;
    }
  }

  /** What a cast looks like, by family (original implementation). */
  private castVisuals(
    e: Extract<SimEvent, { type: 'cast' }>,
    x: number,
    y: number,
    frame: Frame,
    r: number,
  ): void {
    const { fx, camera } = this.k;
    const col = typeColor(e.moveType);
    const vis = vfxForMove(e.moveId, e.moveType);
    const m = frame.snap.details[e.playerId]?.moves.find((q) => q.id === e.moveId);
    const st = moveStatsAt(e.moveId, m?.level ?? 1, m?.evolved ?? false);
    const ca = Math.cos(e.aim);
    const sa = Math.sin(e.aim);
    const own = e.playerId === frame.selfId;
    switch (e.kind) {
      case 'projectile':
        fx.spark(x + ca * r, y - LIFT + sa * r, col, ca, sa, 3);
        return;
      case 'cone':
        fx.spark(x + ca * r, y - LIFT + sa * r, col, ca, sa, 5);
        return;
      case 'nova':
        fx.ring(x, y, r, r * 4, col, 0.3, 3);
        return;
      case 'melee':
        fx.slash(x, y - LIFT * 0.5, e.aim, st.radius ?? 60, st.arc ?? 2, vis);
        return;
      case 'beam':
        fx.beam(x, y - LIFT, e.aim, e.length ?? st.radius ?? 200, st.width ?? 16, vis);
        if (own) camera.kick(0.08);
        return;
      case 'aura': {
        const radius = st.radius ?? 80;
        fx.ring(x, y, radius * 0.5, radius, col, 0.28, 2);
        if (!vis.aura) return;
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = radius * rand(0.45, 1);
          const px = x + Math.cos(a) * rr;
          const py = y + Math.sin(a) * rr * 0.8 - LIFT * 0.5;
          // Giga Drain pulls in; poison and shadows rise; the rest swirl.
          const v = vis.inward
            ? [-Math.cos(a) * rr * 2.2, -Math.sin(a) * rr * 1.8]
            : vis.rise
              ? [rand(-10, 10), -55]
              : [-Math.sin(a) * 70, Math.cos(a) * 55];
          fx.sp(vis.aura, vis.pal, px, py, {
            vx: v[0],
            vy: v[1],
            life: 0.42,
            spin: vfxSpins(vis.aura) ? rand(-6, 6) : 0,
          });
        }
        return;
      }
      case 'buff':
        fx.ring(x, y, r * 2.4, r * 1.1, col, 0.35, 2.5);
        for (let i = 0; i < 3; i++)
          fx.sp(vis.buff ?? 'arrow', vis.pal, x + rand(-r * 1.4, r * 1.4), y - rand(0, 30), {
            vy: -70,
            life: 0.6,
          });
        return;
      case 'chain': {
        let fx0 = x;
        let fy0 = y - LIFT;
        for (const pt of e.chain ?? []) {
          const tx = pt.x;
          const ty = pt.y - 12;
          fx.beam(
            fx0,
            fy0,
            Math.atan2(ty - fy0, tx - fx0),
            Math.hypot(tx - fx0, ty - fy0),
            10,
            vis,
          );
          fx0 = tx;
          fy0 = ty;
        }
        if (own) camera.kick(0.05);
        return;
      }
      case 'turret':
        fx.ring(x, y, 4, 30, col, 0.3, 2);
        return;
      case 'dash': {
        const len = e.length ?? 0;
        // The trail: copies of the hit along the way (`x, y`: where the dash started).
        for (let d = 0; d <= len; d += 22)
          fx.sp(vis.proj, vis.pal, x + ca * d, y + sa * d - LIFT * 0.6, {
            life: 0.22,
            angle: e.aim,
          });
        fx.slash(x + ca * len, y + sa * len - LIFT * 0.5, e.aim, 34, 2.2, vis);
        if (own) camera.kick(0.12);
        return;
      }
      default:
        return;
    }
  }
}
