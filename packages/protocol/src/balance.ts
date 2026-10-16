// A player's balance record for one run: analytics only, for the admin run export (R11). The sim
// collects it (`packages/sim` `balance.ts`) and it travels with the player's `RunSummary`
// (`balance`). It never affects rewards: the server stores it alongside the credited run, and
// for solo runs treats it as untrusted (validated, size-capped, flagged when implausible).

/** Layout of `BalanceRecord`; bump on incompatible changes (the export keeps old ones as stored). */
export const BALANCE_RECORD_VERSION = 1;

/** What hurt a player. `dex` and `tier` are absent for the map's own damage. */
export interface HitSource {
  /**
   * `contact` an enemy touched them, `shot` an enemy projectile, `zone` / `beam` a telegraphed
   * attack (boss skills, zoners, jumps, fuses), `liquid` lava and the like, `trap` a trap tile,
   * `weather` sand or snow chip damage.
   */
  kind: 'contact' | 'shot' | 'zone' | 'beam' | 'liquid' | 'trap' | 'weather';
  dex?: number;
  /** `wild` an ordinary spawn, `elite` a spawn at the enemy cap, `boss`, or a rift `legend`. */
  tier?: 'wild' | 'elite' | 'boss' | 'legend';
}

/** A level-up card the player took. */
export interface BalancePick {
  /** Run time (s). */
  t: number;
  /** The level the card was for. */
  lv: number;
  /** Card id: `new:<move>`, `upgrade:<move>`, `evolution:<move>`, `stat:<card>`. */
  card: string;
  /** Stat cards: the rarity tier id. */
  rarity?: string;
  /**
   * Stat cards: the effect's value at that rarity (a multiplier such as 1.12 for `mul` stats, an
   * amount for `add` stats and max HP, the max-HP fraction for a heal).
   */
  value?: number;
  /** It was picked for the player (choice deadline, disconnect), not by them. */
  auto?: true;
  /**
   * The other cards of the offer, stat cards with their rarity (`stat:attack@rare`). Offers
   * rerolled away are not kept.
   */
  declined: string[];
}

/** The player's state at the end of a minute (or at the end of the run: the last sample). */
export interface BalanceSample {
  /** Run time (s): 60, 120, …; the last one may be the run's end. */
  t: number;
  /** Team level. */
  lv: number;
  hp: number;
  maxHp: number;
  /** The whole move-damage multiplier over the species' base attack (Momentum included). */
  atk: number;
  /** Its factors: stat cards (Power), permanent upgrades, held item, prestige stars. */
  atkCard: number;
  atkUpgrade: number;
  atkItem: number;
  atkPrestige: number;
  /** Altar powers and anything else on the attack multiplier not covered above. */
  atkOther: number;
  /** Attack buffs from moves. */
  atkBuff: number;
  atkMomentum: number;
  /** Cooldown multiplier (lower is faster). */
  cd: number;
  /** Defence in effect (`defenseOf`): damage taken ÷ (1 + def). */
  def: number;
  /** HP per second. */
  regen: number;
  /** Movement speed multiplier over the species' base speed (weather and traps included). */
  spd: number;
  /** Critical hit chance, 0–1. */
  crit: number;
  /** Team kills so far, and this player's last hits so far. */
  kills: number;
  lastHits: number;
  /** Damage dealt and taken in this minute (since the previous sample). */
  dealt: number;
  taken: number;
  /** Momentum stacks now, and their average over the minute. */
  mom: number;
  momAvg: number;
  /** Enemies alive (on the map, or in the arena during a rift). */
  enemies: number;
  /** Times down and revives given in this minute. */
  downs: number;
  revives: number;
  /** Down at the sample. */
  down?: true;
  /** In a rift arena at the sample. */
  rift?: true;
}

/** The player went down (in a group they may be revived; solo, or everyone down, it ends the run). */
export interface BalanceDown {
  t: number;
  /** The hit that downed them (null: unknown). */
  by: HitSource | null;
  /** Damage taken in the ~10 s before, that hit included. */
  taken10s: number;
  /** Down in a rift arena (a lost rift fight sends the team back instead of ending the run). */
  rift?: true;
  /** When they were back up (a teammate, or leaving the arena); null: they stayed down. */
  revivedAt: number | null;
}

/** A rift the team entered. */
export interface BalanceRift {
  t: number;
  /** The legendary and the arena type. */
  dex: number;
  type: string;
  /** null: the run ended in the arena. */
  result: 'won' | 'lost' | null;
  /** Seconds in the fight. */
  dur: number;
}

export interface BalanceRecord {
  v: typeof BALANCE_RECORD_VERSION;
  setup: {
    dex: number;
    shiny: boolean;
    prestige: number;
    /** Permanent upgrade levels by upgrade id (levels above 0). */
    upgrades: Record<string, number>;
    /** Players in the run. */
    players: number;
    /** Moves the player started with. */
    startMoves: string[];
    /** Run time the record starts at: 0, or later for a game saved before records existed. */
    from: number;
  };
  end: {
    /** Run time (s). */
    t: number;
    /** How the run ended (null: still going, e.g. a checkpoint or a server shutdown). */
    reason: 'all-down' | 'everyone-left' | null;
    /** The player left before the end. */
    left: boolean;
    level: number;
    kills: number;
    lastHits: number;
    damageDealt: number;
    damageTaken: number;
    downs: number;
    revivesGiven: number;
    item: string | null;
    rerolls: number;
  };
  /** Final moves, with when each was learned (0: at the start) and evolved. */
  moves: {
    id: string;
    level: number;
    evolved: boolean;
    learnedAt: number;
    evolvedAt: number | null;
  }[];
  /** Held items, in the order equipped. */
  items: { t: number; id: string }[];
  picks: BalancePick[];
  timeline: BalanceSample[];
  downs: BalanceDown[];
  rifts: BalanceRift[];
}
