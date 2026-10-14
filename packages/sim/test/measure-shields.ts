// Controlled headless encounter: `pnpm --filter @pokesurvivor/sim shields`.
// Uses the real spawn scaling, shield AI, timers and damage absorption. Neutral single-target
// DPS is a representative Tackle build, delivered in half-second hits to isolate shielding
// from aim, knockback, terrain, healers and player movement. It is a balance fixture, not telemetry.
import { pathToFileURL } from 'node:url';
import { DT } from '../src/constants.js';
import { hurtEnemy, updateEnemies } from '../src/enemies.js';
import { spawnOne } from '../src/spawner.js';
import { player, quietSim, spawnDummy } from './helpers.js';

export function measureShields(minute: number, shielders: number, healers = 0) {
  const sim = quietSim();
  const p = player(sim);
  const d = sim.ctx.d;
  const time = minute * 60;
  const tier = d.game.enemies.tiers.findLastIndex((t) => t.from <= time);
  const defs = (d.tierCandidates[tier] ?? [])
    .map((mon) => d.enemyDef(mon, tier))
    .filter((def) => ['chase', 'charger', 'ranged'].includes(def.behavior))
    .sort((a, b) => a.hp - b.hp || a.dex - b.dex);
  const def = defs[Math.floor(defs.length / 2)]!;
  sim.state.roster.tiers = [{ from: 0, list: [def] }];
  sim.state.time = time;
  const target = spawnOne(sim.ctx, p, time)!;
  target.behavior = 'chase';
  target.speed = 0;
  target.flying = true;
  target.r = 0;
  // Keep healers inside their player activation range as well as the ally-heal radius.
  target.x = p.x + 140;
  target.y = p.y;
  const level = Math.min(minute === 3 ? 3 : 5, d.maxMoveLevel('tackle'));
  p.attackMul = minute === 3 ? 1.4 : minute === 8 ? 2 : 3;
  const attack = p.baseAttack * p.attackMul;
  const stats = d.moveStats('tackle', level, minute === 15);
  const hit = Math.round(((stats.damage ?? 0) * attack * 0.5) / (stats.cooldown ?? 1));
  for (let i = 0; i < shielders; i++) {
    const angle = (i * Math.PI * 2) / Math.max(1, shielders + healers);
    const caster = spawnDummy(
      sim,
      target.x + Math.cos(angle) * 80,
      target.y + Math.sin(angle) * 80,
      { behavior: 'shielder' },
    );
    caster.flying = true;
    caster.r = 0;
    // An already-engaged pack: first shield at t=0, staggered overlapping casters thereafter.
    caster.skillCd = i * 2;
  }
  const healerDef = d.enemyDef(d.game.pokemonByDex.get(113)!, tier);
  for (let i = 0; i < healers; i++) {
    const angle = ((i + shielders) * Math.PI * 2) / Math.max(1, shielders + healers);
    const caster = spawnDummy(
      sim,
      target.x + Math.cos(angle) * 80,
      target.y + Math.sin(angle) * 80,
      {
        dex: 113,
        behavior: 'healer',
        shotCooldown: healerDef.shotCooldown,
        range: healerDef.range,
      },
    );
    caster.flying = true;
    caster.r = 0;
    caster.shotCd = i * 1.1;
  }
  let absorbed = 0;
  let healed = 0;
  let dealt = 0;
  const limit = 180;
  let ticks = 0;
  for (; ticks < limit / DT && !target.dead; ticks++) {
    const hpBeforeUpdate = target.hp;
    updateEnemies(sim.ctx);
    healed += Math.max(0, target.hp - hpBeforeUpdate);
    if (ticks % 15 === 0) {
      const before = target.shield;
      const hp = target.hp;
      hurtEnemy(sim.ctx, target, hit);
      absorbed += before - target.shield;
      dealt += Math.min(hp, hp - target.hp);
    }
    sim.state.time += DT;
    sim.drainEvents();
  }
  return {
    minute,
    dex: target.dex,
    hp: target.maxHp,
    level,
    evolved: minute === 15,
    attack,
    dps: hit * 2,
    shielders,
    healers,
    ttk: target.dead ? ticks * DT : null,
    absorbed,
    healed,
    effectiveHp: target.maxHp + absorbed + healed,
    // For censored encounters this is a lower bound: more shields can be absorbed after 180 s.
    shieldShare: absorbed / (absorbed + healed + target.maxHp),
    damageShare: absorbed / (absorbed + dealt),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const minute of [3, 8, 15]) {
    for (const shielders of [0, 1, 3])
      console.log(JSON.stringify(measureShields(minute, shielders)));
  }
}
