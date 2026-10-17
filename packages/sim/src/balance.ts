// Balance records (R11): per player, what explains an easy or a hard run — the setup, every card
// taken (and the ones declined), a sample of their stats at the end of every minute, what downed
// them, and the rifts. Analytics only: nothing here affects the game. It is plain state on the
// player (`PlayerState.balance`), so it is deterministic, survives saves and restores, and costs
// a few additions per tick. `balanceRecord` turns it into the protocol's `BalanceRecord`.
import {
  BALANCE_RECORD_VERSION,
  type BalanceRecord,
  type BalanceSample,
  type HitSource,
} from '@pokesurvivor/protocol';
import { presentPlayers, type Ctx } from './ctx.js';
import { momentumMultiplier } from './momentum.js';
import { attackOf, defenseOf, moveSpeedOf, regenOf } from './players.js';
import { rarityTier, scaledCardEffect } from './rarity.js';
import type { BalanceState, CardOption, EnemyState, LevelUpChoice, PlayerState } from './state.js';

/** Seconds of damage kept for "what happened just before they went down". */
const RECENT_S = 10;

/** Rounds to 3 decimals (keeps records small; analytics don't need more). */
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function newBalance(
  setup: Pick<BalanceState, 'prestige' | 'upgrades' | 'players' | 'atkUpgrade' | 'atkPrestige'>,
  from = 0,
): BalanceState {
  return {
    ...setup,
    startMoves: [],
    from,
    picks: [],
    items: [],
    timeline: [],
    downs: [],
    rifts: [],
    wildLegends: [],
    taken: 0,
    at: { dealt: 0, taken: 0, downs: 0, revives: 0 },
    momSum: 0,
    momN: 0,
    recent: new Array<number>(RECENT_S).fill(0),
    recentS: 0,
    lastHit: null,
  };
}

/** What an enemy is, for a `HitSource`. */
export function enemyRef(e: EnemyState): Required<Pick<HitSource, 'dex' | 'tier'>> {
  const tier = e.wildLegend
    ? 'wildLegend'
    : e.legend
      ? 'legend'
      : e.boss
        ? 'boss'
        : e.regularHit === false
          ? 'elite'
          : 'wild';
  return { dex: e.dex, tier };
}

/** Moves the 10-second window up to the current second (clearing the seconds in between). */
function rollRecent(b: BalanceState, now: number): number {
  const sec = Math.floor(now);
  if (sec > b.recentS) {
    for (let s = b.recentS + 1; s <= Math.min(sec, b.recentS + RECENT_S); s++)
      b.recent[s % RECENT_S] = 0;
    b.recentS = sec;
  }
  return sec;
}

/** Damage a player took (after defence), and from what. */
export function noteDamageTaken(ctx: Ctx, p: PlayerState, amount: number, by: HitSource | null) {
  const b = p.balance;
  if (!b) return;
  b.taken += amount;
  const sec = rollRecent(b, ctx.s.time);
  b.recent[sec % RECENT_S] = (b.recent[sec % RECENT_S] ?? 0) + amount;
  b.lastHit = by;
}

export function noteDown(ctx: Ctx, p: PlayerState) {
  const b = p.balance;
  if (!b) return;
  rollRecent(b, ctx.s.time);
  b.downs.push({
    t: r3(ctx.s.time),
    by: b.lastHit,
    taken10s: Math.round(b.recent.reduce((a, x) => a + x, 0)),
    ...(ctx.s.arena ? { rift: true as const } : {}),
    revivedAt: null,
  });
}

export function noteRevive(ctx: Ctx, p: PlayerState) {
  const d = p.balance?.downs.at(-1);
  if (d && d.revivedAt === null) d.revivedAt = r3(ctx.s.time);
}

export function noteItem(ctx: Ctx, p: PlayerState, id: string) {
  p.balance?.items.push({ t: r3(ctx.s.time), id });
}

/** A level-up card was taken (`auto`: by the deadline or a disconnect). */
export function notePick(
  ctx: Ctx,
  p: PlayerState,
  c: LevelUpChoice,
  card: CardOption,
  auto: boolean,
) {
  const b = p.balance;
  if (!b) return;
  let value: number | undefined;
  if (card.type === 'stat' && card.statId) {
    const tier = rarityTier(ctx.d.game.levelUp.rarity, card.rarity);
    const e = scaledCardEffect(ctx.d.statCard(card.statId).effect, tier?.multiplier ?? 1);
    value = r3(e.type === 'heal' ? e.maxHpFraction : e.value);
  }
  b.picks.push({
    t: r3(ctx.s.time),
    lv: c.level,
    card: card.id,
    ...(card.rarity ? { rarity: card.rarity } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(auto ? { auto: true as const } : {}),
    declined: c.options
      .filter((o) => o !== card)
      .map((o) => (o.rarity ? `${o.id}@${o.rarity}` : o.id)),
  });
}

/** The team entered a rift arena. */
export function noteRiftStart(ctx: Ctx) {
  const a = ctx.s.arena;
  if (!a) return;
  for (const p of presentPlayers(ctx.s))
    p.balance?.rifts.push({ t: r3(ctx.s.time), dex: a.dex, type: a.type, result: null, dur: 0 });
}

/** The rift fight is over (the team goes back a few seconds later). */
export function noteRiftEnd(ctx: Ctx, result: 'won' | 'lost') {
  const a = ctx.s.arena;
  if (!a) return;
  for (const p of ctx.s.players) {
    const r = p.balance?.rifts.at(-1);
    if (r && r.result === null) {
      r.result = result;
      r.dur = r3(a.t);
    }
  }
}

/** A wild legendary appeared on the map. */
export function noteWildLegendSpawn(ctx: Ctx, e: EnemyState) {
  for (const p of presentPlayers(ctx.s))
    p.balance?.wildLegends.push({
      id: e.id,
      t: r3(ctx.s.time),
      dex: e.dex,
      maxHp: Math.round(e.maxHp),
      defeatedAt: null,
      dealt: 0,
    });
}

const wildLegendOf = (p: PlayerState | undefined, id: number) =>
  p?.balance?.wildLegends.findLast((w) => w.id === id);

/** A player took `amount` HP off a wild legendary. */
export function noteWildLegendHit(ctx: Ctx, e: EnemyState, by: string, amount: number) {
  const w = wildLegendOf(
    ctx.s.players.find((p) => p.id === by),
    e.id,
  );
  if (w) w.dealt += amount;
}

/** A wild legendary was defeated: when, and who dealt it the most damage. */
export function noteWildLegendDefeated(ctx: Ctx, e: EnemyState) {
  const entries = ctx.s.players.map((p) => wildLegendOf(p, e.id)).filter((w) => w !== undefined);
  let top: (typeof entries)[number] | undefined;
  for (const w of entries) {
    w.defeatedAt = r3(ctx.s.time);
    if (w.dealt > (top?.dealt ?? 0)) top = w;
  }
  if (top) top.top = true;
}

/** Product of a player's stat-card multipliers on attack (Power). */
function cardAttack(ctx: Ctx, p: PlayerState): number {
  let k = 1;
  for (const [id, built] of Object.entries(p.cardMul)) {
    const e = ctx.d.game.statCardById.get(id)?.effect;
    if (e?.type === 'stat' && e.stat === 'attackMul') k *= built;
  }
  return k;
}

function itemAttack(ctx: Ctx, p: PlayerState): number {
  let k = 1;
  if (p.item)
    for (const e of ctx.d.item(p.item).effects)
      if (e.stat === 'attackMul' && e.op === 'mul') k *= e.value;
  return k;
}

/** The player's sample now; `t` is the time it's for. */
function sample(ctx: Ctx, p: PlayerState, b: BalanceState, t: number): BalanceSample {
  const { s } = ctx;
  const card = cardAttack(ctx, p);
  const item = itemAttack(ctx, p);
  const known = card * item * b.atkUpgrade * b.atkPrestige;
  const atkMomentum = momentumMultiplier(ctx, p.momentum);
  return {
    t: r3(t),
    lv: s.team.level,
    hp: Math.round(p.hp),
    maxHp: Math.round(p.maxHp),
    atk: r3(attackOf(ctx, p) / p.baseAttack),
    atkCard: r3(card),
    atkUpgrade: r3(b.atkUpgrade),
    atkItem: r3(item),
    atkPrestige: r3(b.atkPrestige),
    atkOther: r3(known > 0 ? p.attackMul / known : 1),
    atkBuff: r3(1 + p.buffs.attack.n * p.buffs.attack.amount),
    atkMomentum: r3(atkMomentum),
    cd: r3(p.cooldownMul),
    def: r3(defenseOf(ctx, p)),
    regen: r3(regenOf(p)),
    spd: r3(moveSpeedOf(ctx, p) / p.baseSpeed),
    crit: r3(p.critChance),
    kills: s.team.kills,
    lastHits: p.stats.lastHits,
    dealt: Math.round(p.stats.damageDealt - b.at.dealt),
    taken: Math.round(b.taken - b.at.taken),
    mom: r3(p.momentum),
    momAvg: r3(b.momN ? b.momSum / b.momN : p.momentum),
    enemies: s.enemies.reduce((n, e) => n + (e.dead ? 0 : 1), 0),
    downs: p.stats.timesDown - b.at.downs,
    revives: p.stats.revivesGiven - b.at.revives,
    ...(p.dead ? { down: true as const } : {}),
    ...(s.arena ? { rift: true as const } : {}),
  };
}

/** Every running tick: Momentum's average, and a sample at the end of each minute. */
export function tickBalance(ctx: Ctx): void {
  const { s } = ctx;
  const minute = Math.floor(s.time / 60 + 1e-9);
  for (const p of s.players) {
    const b = p.balance;
    if (!b || p.left) continue;
    b.momSum += p.momentum;
    b.momN++;
    const due = Math.floor(b.from / 60 + 1e-9) + b.timeline.length + 1;
    if (minute < due) continue;
    b.timeline.push(sample(ctx, p, b, minute * 60));
    b.at = {
      dealt: p.stats.damageDealt,
      taken: b.taken,
      downs: p.stats.timesDown,
      revives: p.stats.revivesGiven,
    };
    b.momSum = 0;
    b.momN = 0;
  }
}

/**
 * The player's record as of now. If the run is past the last whole-minute sample, a last
 * sample for the time since is added (not stored), so short runs and the final seconds count.
 */
export function balanceRecord(ctx: Ctx, p: PlayerState): BalanceRecord | undefined {
  const b = p.balance;
  if (!b) return undefined;
  const { s } = ctx;
  const timeline = [...b.timeline];
  const lastT = timeline.at(-1)?.t ?? b.from;
  if (!p.left && s.time - lastT >= 1) timeline.push(sample(ctx, p, b, s.time));
  const learnedAt = new Map<string, number>();
  const evolvedAt = new Map<string, number>();
  for (const k of b.picks) {
    const [type, id = ''] = k.card.split(':');
    if (type === 'new' && !learnedAt.has(id)) learnedAt.set(id, k.t);
    if (type === 'evolution') evolvedAt.set(id, k.t);
  }
  return {
    v: BALANCE_RECORD_VERSION,
    setup: {
      dex: p.dex,
      shiny: p.shiny,
      prestige: b.prestige,
      upgrades: { ...b.upgrades },
      players: b.players,
      startMoves: [...b.startMoves],
      from: b.from,
    },
    end: {
      t: r3(s.time),
      reason: s.ended?.reason ?? null,
      left: p.left,
      level: s.team.level,
      kills: s.team.kills,
      lastHits: p.stats.lastHits,
      damageDealt: Math.round(p.stats.damageDealt),
      damageTaken: Math.round(b.taken),
      downs: p.stats.timesDown,
      revivesGiven: p.stats.revivesGiven,
      item: p.item,
      rerolls: p.rerollsUsed,
    },
    moves: p.moves.map((m) => ({
      id: m.id,
      level: m.level,
      evolved: m.evolved,
      learnedAt: learnedAt.get(m.id) ?? 0,
      evolvedAt: evolvedAt.get(m.id) ?? null,
    })),
    items: b.items.map((i) => ({ ...i })),
    picks: b.picks.map((k) => ({ ...k, declined: [...k.declined] })),
    timeline,
    downs: b.downs.map((d) => ({ ...d, by: d.by && { ...d.by } })),
    rifts: b.rifts.map((r) => ({ ...r })),
    wildLegends: b.wildLegends.map((w) => ({
      t: w.t,
      dex: w.dex,
      maxHp: w.maxHp,
      defeatedAt: w.defeatedAt,
      dealt: Math.round(w.dealt),
      ...(w.top ? { top: true as const } : {}),
    })),
  };
}
