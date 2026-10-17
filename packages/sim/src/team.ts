// Team XP and level, shared by everyone as in legacy co-op.
import { activePlayers, emit, type Ctx } from './ctx.js';
import type { TeamState } from './state.js';

/** XP needed to go from `level` to the next (×2 then ×4 on 2026-10-10: levels came too fast). */
export function xpFor(level: number): number {
  return Math.floor((8 + level * 6 + Math.pow(level, 1.75) * 1.6) * 4);
}

export function newTeam(): TeamState {
  return {
    level: 1,
    xp: 0,
    xpNext: xpFor(1),
    kills: 0,
    bosses: 0,
    coins: 0,
    tickets: 0,
    tickets10: 0,
    gems: 0,
    shinies: [],
  };
}

/**
 * XP multiplier: the average of everyone's XP bonus, split across the team (legacy
 * `Coop.xpFactor`: groups level ~1/(1 + 0.6·(n−1)) as fast per gem, or they'd level 3× faster
 * than solo). Solo it's just your own bonus.
 */
export function teamXpFactor(ctx: Ctx): number {
  const players = activePlayers(ctx.s);
  const n = players.length;
  if (!n) return 0;
  const avg = players.reduce((a, p) => a + p.xpMul, 0) / n;
  return avg / (1 + 0.6 * (n - 1));
}

/** Adds XP; queues a round of level-up cards per level gained. */
export function gainTeamXp(ctx: Ctx, amount: number): void {
  const team = ctx.s.team;
  team.xp += amount * teamXpFactor(ctx);
  while (team.xp >= team.xpNext) {
    team.xp -= team.xpNext;
    team.level++;
    team.xpNext = xpFor(team.level);
    ctx.s.pendingLevels++;
    emit(ctx, { type: 'level-up', level: team.level });
  }
}

/** XP still needed for the next level, before multipliers (2b: locked chests give this much). */
export function xpToNextLevel(ctx: Ctx): number {
  const k = teamXpFactor(ctx) || 1;
  return Math.ceil((ctx.s.team.xpNext - ctx.s.team.xp + 1) / k);
}
