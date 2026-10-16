// The HTTP API (docs/api.md), typed for the client. The server owns every value here: the
// client shows them and sends intents (pull, buy, claim), never computed results.
import type { ConfigIssue, ConfigOverrides, TunableConfig } from '@pokesurvivor/data';
import type {
  PresenceStatus,
  RunConfigWire,
  RunSummary,
  UnlockedAchievement,
} from '@pokesurvivor/protocol';
import type { SyncedSettings } from '../settings.js';

export interface User {
  id: string;
  username: string;
  /** Can open `#/admin` (live tuning). Absent from older servers. */
  isAdmin?: boolean;
}

export interface Acquisition {
  at: number;
  from: 'starter' | 'gacha' | 'wild' | 'rescue' | 'reward';
}

export interface MissionState {
  id: string;
  goal: number;
  param: string | null;
  progress: number;
  claimed: boolean;
}

export interface MissionSet {
  period: string | null;
  rerolled: boolean;
  missions: MissionState[];
}

export interface Missions {
  daily: MissionSet;
  weekly: MissionSet;
}

/** `PUT /api/save/moves/:dex`: slot bindings, bans and the Repertoire move (null: random). */
export interface MovesBody {
  bindings?: (string | null)[];
  bans?: string[];
  repertoire?: string | null;
}

/** `GET /api/save/upgrades/reset/:dex`. */
export interface ResetQuote {
  dex: number;
  /** PokéCoins a reset gives back (0: nothing bought since the last prestige or reset). */
  refund: number;
  /** Gems it costs. */
  cost: number;
}

export interface PokemonRef {
  dex: number;
  shiny: boolean;
}

export interface Save {
  version: number;
  coins: number;
  tickets: { x1: number; x10: number };
  /** Gems (R6). Optional: saves cached before gems lack it. */
  gems?: number;
  partner: { dex: number | null; shiny: boolean };
  owned: Record<string, Acquisition>;
  shiny: Record<string, Acquisition>;
  starter: number | null;
  personality: { trait: string; scores: Record<string, number> } | null;
  upgrades: Record<string, Record<string, number>>;
  /** dex -> prestige stars (absent: none). Optional: saves cached before prestige lack it. */
  prestige?: Record<string, number>;
  moveBindings: Record<string, (string | null)[]>;
  moveBans: Record<string, string[]>;
  /** dex -> the chosen Repertoire move (absent: random). Optional: older cached saves lack it. */
  repertoireMoves?: Record<string, string>;
  pity: Record<string, number>;
  stats: {
    runs: number;
    groupRuns: number;
    bestTimeS: number;
    bestGroupTimeS: number;
    bestLevel: number;
    totalKills: number;
    bossesTotal: number;
    coinsEarned: number;
    shinies: number;
    pulls: number;
    riftWins: number;
    evolutions: number;
    missionsDone: number;
  };
  achievements: Record<string, number>;
  legendsBeaten: Record<string, number>;
  arenasWon: Record<string, number>;
  itemsFound: Record<string, number>;
  movesEvolved: Record<string, number>;
  missions: Missions;
  profile: { favourites: PokemonRef[]; title: string | null };
  settings: SyncedSettings;
  updatedAt: string;
}

export type { UnlockedAchievement };

export interface GachaBanner {
  id: string;
  gen: number;
  name: string;
  colors: string[];
  featured: number[];
  poolSize: Record<string, number>;
  pity: number | null;
}

export interface GachaInfo {
  cost: { single: number; multi: number; multiCount: number; multiTickets10: number };
  rates: { rarity: number; weight: number }[];
  softPity: { from: number; stepPerPull: number };
  hardPity: number;
  multiGuaranteeMinRarity: number;
  shinyRate: number;
  duplicateRefund: { rarity: number; coins: number }[];
  shinyDuplicateMultiplier: number;
  rarities: { rarity: number; name: string; color: string }[];
  banners: GachaBanner[];
}

export interface PullResult {
  dex: number;
  rarity: number;
  shiny: boolean;
  isNew: boolean;
  refund: number;
}

export interface PullResponse {
  pullId: string;
  banner: string;
  results: PullResult[];
  pity: number;
  achievements: UnlockedAchievement[];
  save: Save;
}

export type PayWith = 'tickets' | 'tickets10';

export interface FriendBase {
  username: string;
  /** `prestige`: the partner's stars, absent when it has none. */
  partner: (PokemonRef & { prestige?: number }) | null;
  favourites: PokemonRef[];
  title: string | null;
}
export interface Friend extends FriendBase {
  since: string;
  presence: PresenceStatus;
}
export interface FriendRequest extends FriendBase {
  sentAt: string;
}
export interface FriendsList {
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export type LeaderboardMode = 'solo' | 'group';
export type LeaderboardPeriod = 'daily' | 'weekly' | 'all';
export interface LeaderboardEntry {
  rank: number;
  durationS: number;
  endedAt: string;
  players: { username: string; pokemon: PokemonRef; level: number; kills: number }[];
}
export interface Leaderboard {
  mode: LeaderboardMode;
  period: LeaderboardPeriod;
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
}

export interface RunReport {
  runId: string;
  stats: unknown;
  capped: boolean;
  achievements: UnlockedAchievement[];
  save: Save;
}

/** A stored solo run checkpoint (`POST /api/runs/checkpoint`): nothing is credited yet. */
export interface RunCheckpoint {
  runId: string;
  stats: unknown;
  capped: boolean;
}

/** A solo run as the server starts it, with the config it issues the run (live tuning). */
export interface StartedRun {
  runId: string;
  startedAt: string;
  /** Absent from older servers: the built-in data. */
  config?: RunConfigWire;
}

/** A published live-tuning config version (admin). */
export interface ConfigVersionView {
  version: number;
  createdAt: string;
  createdBy: string | null;
  note: string | null;
  revertedFrom: number | null;
  /** The overrides in effect. */
  overrides: ConfigOverrides;
  /** Stored overrides this build skips (their defaults apply). */
  skipped: ConfigIssue[];
  /** The effective files. */
  config: TunableConfig;
}

export interface ConfigVersionSummary {
  version: number;
  createdAt: string;
  createdBy: string | null;
  note: string | null;
  revertedFrom: number | null;
  /** Settings it changes from the defaults. */
  changes: number;
}

/** "Export as patch" (`GET /api/admin/config/patch`). */
export interface ConfigPatch {
  format: 'pokesurvivor-tuning-patch';
  version: number;
  exportedAt: string;
  overrides: ConfigOverrides;
}

/** An API error: `code` is stable and maps to a UI string (`errors.<code>` in en.json). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The error body's other fields (e.g. `credited` with `run_credited_by_timeout`). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export class Api {
  /** Called on every 401 from an endpoint that needs a login (the session expired). */
  onUnauthenticated: (() => void) | null = null;
  /** Called with the server's build on every response that names one (`X-Build`). */
  onBuild: ((build: string, version: string | undefined) => void) | null = null;

  constructor(private readonly fetcher: Fetch = (...args) => fetch(...args)) {}

  /** `keepalive`: the request outlives the page (checkpoints sent as the tab is hidden or closed). */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { keepalive?: boolean } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        keepalive: opts.keepalive,
      });
    } catch (err) {
      throw new ApiError(0, 'network', err instanceof Error ? err.message : String(err));
    }
    const build = res.headers.get('x-build');
    if (build) this.onBuild?.(build, res.headers.get('x-build-version') ?? undefined);
    if (res.status === 204) return undefined as T;
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = (
        data as { error?: { code?: string; message?: string } & Record<string, unknown> } | null
      )?.error;
      const code = error?.code ?? (res.status >= 500 ? 'server_error' : 'unknown');
      if (res.status === 401 && code === 'unauthenticated') this.onUnauthenticated?.();
      throw new ApiError(res.status, code, error?.message ?? res.statusText, error ?? {});
    }
    return data as T;
  }

  // ---------------------------------------------------------------- auth

  me() {
    return this.request<{ user: User }>('GET', '/api/auth/me');
  }
  login(username: string, password: string) {
    return this.request<{ user: User }>('POST', '/api/auth/login', { username, password });
  }
  register(username: string, password: string) {
    return this.request<{ user: User }>('POST', '/api/auth/register', { username, password });
  }
  logout() {
    return this.request<void>('POST', '/api/auth/logout');
  }
  info() {
    return this.request<{ protocolVersion: number; tickHz: number }>('GET', '/api/info');
  }

  // ---------------------------------------------------------------- save

  save() {
    return this.request<Save>('GET', '/api/save');
  }
  setPartner(dex: number, shiny: boolean) {
    return this.request<Save>('PUT', '/api/save/partner', { dex, shiny });
  }
  setProfile(profile: { favourites?: PokemonRef[]; title?: string | null }) {
    return this.request<Save>('PATCH', '/api/save/profile', profile);
  }
  setSettings(settings: Partial<SyncedSettings>) {
    return this.request<Save>('PATCH', '/api/save/settings', settings);
  }
  chooseStarter(dex: number, answers?: number[]) {
    return this.request<{ achievements: UnlockedAchievement[]; save: Save }>(
      'POST',
      '/api/save/starter',
      answers ? { dex, answers } : { dex },
    );
  }
  setMoves(dex: number, moves: MovesBody) {
    return this.request<Save>('PUT', `/api/save/moves/${dex}`, moves);
  }
  buyUpgrade(dex: number, upgradeId: string) {
    return this.request<Save>('POST', '/api/save/upgrades', { dex, upgradeId });
  }
  /** Resets a fully upgraded Pokémon's upgrades for a prestige star (and gems). */
  prestige(dex: number) {
    return this.request<Save>('POST', '/api/save/prestige', { dex });
  }
  /** What resetting a Pokémon's upgrades would refund now, and its gem cost. */
  resetQuote(dex: number) {
    return this.request<ResetQuote>('GET', `/api/save/upgrades/reset/${dex}`);
  }
  /** Resets a Pokémon's upgrades for gems, refunding the coins spent since its last prestige. */
  resetUpgrades(dex: number) {
    return this.request<Save>('POST', '/api/save/upgrades/reset', { dex });
  }

  // ---------------------------------------------------------------- gacha

  gacha() {
    return this.request<GachaInfo>('GET', '/api/gacha');
  }
  pull(banner: string, count: number, payWith: PayWith) {
    return this.request<PullResponse>('POST', '/api/gacha/pull', { banner, count, payWith });
  }

  // ---------------------------------------------------------------- missions

  missions() {
    return this.request<Missions>('GET', '/api/missions');
  }
  claimMission(kind: 'daily' | 'weekly', index: number) {
    return this.request<{ missions: Missions; achievements: UnlockedAchievement[]; save: Save }>(
      'POST',
      `/api/missions/${kind}/${index}/claim`,
    );
  }
  rerollMission(index: number) {
    return this.request<Missions>('POST', `/api/missions/daily/${index}/reroll`);
  }

  // ---------------------------------------------------------------- leaderboard

  leaderboard(q: {
    mode: LeaderboardMode;
    period: LeaderboardPeriod;
    friends?: boolean;
    pokemon?: number;
  }) {
    const params = new URLSearchParams({ mode: q.mode, period: q.period });
    if (q.friends) params.set('friends', 'true');
    if (q.pokemon) params.set('pokemon', String(q.pokemon));
    return this.request<Leaderboard>('GET', `/api/leaderboard?${params}`);
  }

  // ---------------------------------------------------------------- friends

  friends() {
    return this.request<FriendsList>('GET', '/api/friends');
  }
  addFriend(username: string) {
    return this.request<{ status: 'pending' | 'accepted' }>('POST', '/api/friends/requests', {
      username,
    });
  }
  acceptFriend(username: string) {
    return this.request<{ status: 'accepted' }>(
      'POST',
      `/api/friends/requests/${encodeURIComponent(username)}/accept`,
    );
  }
  declineFriend(username: string) {
    return this.request<void>(
      'POST',
      `/api/friends/requests/${encodeURIComponent(username)}/decline`,
    );
  }
  removeFriend(username: string) {
    return this.request<void>('DELETE', `/api/friends/${encodeURIComponent(username)}`);
  }

  // ---------------------------------------------------------------- solo runs

  startRun(pokemon: PokemonRef) {
    return this.request<StartedRun>('POST', '/api/runs/start', { pokemon });
  }
  checkpointRun(runId: string, summary: RunSummary) {
    return this.request<RunCheckpoint>(
      'POST',
      '/api/runs/checkpoint',
      { ...summary, runId },
      { keepalive: true },
    );
  }
  reportRun(runId: string, summary: RunSummary) {
    return this.request<RunReport>('POST', '/api/runs', { ...summary, runId });
  }

  // ---------------------------------------------------------------- live tuning

  /** The published config (what new runs get). */
  config() {
    return this.request<RunConfigWire>('GET', '/api/config');
  }

  // Admin only (404 for everyone else).
  adminConfig() {
    return this.request<{ current: ConfigVersionView; defaults: TunableConfig }>(
      'GET',
      '/api/admin/config',
    );
  }
  configVersions() {
    return this.request<{ versions: ConfigVersionSummary[] }>('GET', '/api/admin/config/versions');
  }
  configVersion(version: number) {
    return this.request<ConfigVersionView>('GET', `/api/admin/config/versions/${version}`);
  }
  publishConfig(config: unknown, baseVersion: number, note?: string) {
    return this.request<ConfigVersionView>('PUT', '/api/admin/config', {
      config,
      baseVersion,
      ...(note ? { note } : {}),
    });
  }
  revertConfig(version: number, baseVersion: number, note?: string) {
    return this.request<ConfigVersionView>('POST', '/api/admin/config/revert', {
      version,
      baseVersion,
      ...(note ? { note } : {}),
    });
  }
  configPatch() {
    return this.request<ConfigPatch>('GET', '/api/admin/config/patch');
  }
  /** Balance records the export filters match (`query`: the export's query string). */
  runExportCount(query: string) {
    return this.request<{ count: number; flagged: number }>(
      'GET',
      `/api/admin/runs/count${query ? `?${query}` : ''}`,
    );
  }
}
