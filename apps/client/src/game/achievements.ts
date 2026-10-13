// Mid-run "achievement unlocked" notices (plan §4b). The server unlocks and pays achievements when
// the run is recorded; during the run the client projects the player's save plus what this run
// has done so far (the snapshot's team totals and the sim's `progress` events) onto the metrics in
// achievements.json, the same way the server's `achievementValue` reads the save, and shows a
// notice the moment one is met. Nothing is credited here.
//
// Metrics that only move when the run is recorded (runs, group runs) or outside runs (gacha
// pulls, missions) are left to the results screen.
import { loadGameData, type Achievement } from '@pokesurvivor/data';
import type { NetTeam } from '@pokesurvivor/netclient';
import type { SimEvent } from '@pokesurvivor/sim';

/** The parts of the server save (`GET /api/save`) the metrics read. */
export interface AchievementSave {
  stats: {
    bestTimeS: number;
    bestLevel: number;
    totalKills: number;
    bossesTotal: number;
    evolutions: number;
    riftWins: number;
    pulls: number;
    runs: number;
    groupRuns: number;
    missionsDone: number;
  };
  achievements: Record<string, unknown>;
  owned: Record<string, unknown>;
  shiny: Record<string, unknown>;
  movesEvolved: Record<string, unknown>;
  itemsFound: Record<string, unknown>;
  arenasWon: Record<string, unknown>;
  legendsBeaten: Record<string, unknown>;
}

/** Metrics a run can move while it's on. */
const LIVE = new Set<Achievement['metric']>([
  'pokemon-owned',
  'shinies-owned',
  'best-time-minutes',
  'best-level',
  'total-defeated',
  'bosses-defeated',
  'move-evolutions',
  'distinct-moves-evolved',
  'distinct-items-found',
  'rift-wins',
  'arenas-won',
  'legendaries-defeated',
  'legendary-defeated',
]);

export class AchievementTracker {
  private time = 0;
  private team: Pick<NetTeam, 'kills' | 'bosses' | 'level' | 'shinies'> = {
    kills: 0,
    bosses: 0,
    level: 1,
    shinies: [],
  };
  private evolutions = 0;
  private readonly movesEvolved = new Set<string>();
  private readonly items = new Set<string>();
  private riftWins = 0;
  private readonly arenas = new Set<string>();
  private readonly legends = new Set<number>();
  private readonly rescued = new Set<number>();
  private readonly shown = new Set<string>();
  private readonly pending: Achievement[];

  constructor(
    private readonly save: AchievementSave,
    private readonly selfId: string,
    defs: readonly Achievement[] = loadGameData().achievements.achievements,
    private readonly isPokemon: (dex: number) => boolean = (dex) =>
      loadGameData().pokemonByDex.has(dex),
  ) {
    // Already unlocked, or not something a run moves: never shown.
    this.pending = defs.filter((a) => save.achievements[a.id] === undefined && LIVE.has(a.metric));
  }

  /** The snapshot's team totals and the run time. */
  observe(team: Pick<NetTeam, 'kills' | 'bosses' | 'level' | 'shinies'>, time: number): void {
    this.team = team;
    this.time = time;
  }

  /** The sim's events, for what the snapshot doesn't total. */
  event(e: SimEvent): void {
    if (e.type === 'progress') {
      const mine = e.playerId === null || e.playerId === this.selfId;
      if (!mine) return;
      const d = e.data;
      if (e.event === 'evolve' && typeof d.move === 'string') {
        this.evolutions++;
        this.movesEvolved.add(d.move);
      } else if (e.event === 'item' && typeof d.id === 'string') this.items.add(d.id);
      else if (e.event === 'rift-win' && typeof d.type === 'string') {
        this.riftWins++;
        this.arenas.add(d.type);
      } else if (e.event === 'defeat' && typeof d.legend === 'number' && d.legend > 0)
        this.legends.add(d.legend);
    } else if (e.type === 'lost-pokemon' && e.phase === 'rescued' && e.joins)
      this.rescued.add(e.dex);
  }

  /** The metric's value as of now (save + this run). */
  value(a: Achievement): number {
    const s = this.save.stats;
    const union = (saved: Record<string, unknown>, run: Iterable<string | number>) => {
      const all = new Set(Object.keys(saved));
      for (const k of run) all.add(String(k));
      return all;
    };
    switch (a.metric) {
      case 'pokemon-owned': {
        const all = union(this.save.owned, [...this.team.shinies, ...this.rescued]);
        return [...all].filter((dex) => this.isPokemon(Number(dex))).length;
      }
      case 'shinies-owned':
        return union(this.save.shiny, this.team.shinies).size;
      case 'best-time-minutes':
        return Math.floor(Math.max(s.bestTimeS, Math.floor(this.time)) / 60);
      case 'best-level':
        return Math.max(s.bestLevel, this.team.level);
      case 'total-defeated':
        return s.totalKills + this.team.kills;
      case 'bosses-defeated':
        return s.bossesTotal + this.team.bosses;
      case 'move-evolutions':
        return s.evolutions + this.evolutions;
      case 'distinct-moves-evolved':
        return union(this.save.movesEvolved, this.movesEvolved).size;
      case 'distinct-items-found':
        return union(this.save.itemsFound, this.items).size;
      case 'rift-wins':
        return s.riftWins + this.riftWins;
      case 'arenas-won':
        return union(this.save.arenasWon, this.arenas).size;
      case 'legendaries-defeated':
        return union(this.save.legendsBeaten, this.legends).size;
      case 'legendary-defeated':
        return a.dex !== undefined &&
          (this.save.legendsBeaten[String(a.dex)] !== undefined || this.legends.has(a.dex))
          ? 1
          : 0;
      default:
        return 0;
    }
  }

  /** Achievements met since the last call (each is reported once). */
  check(): Achievement[] {
    const out: Achievement[] = [];
    for (const a of this.pending) {
      if (this.shown.has(a.id) || this.value(a) < a.goal) continue;
      this.shown.add(a.id);
      out.push(a);
    }
    return out;
  }
}
