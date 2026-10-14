// Client settings: one small store that the settings screen edits and the game (renderer, audio,
// touch controls) reads. Kept in localStorage so they apply before login and offline; the app
// shell also mirrors the synced fields to the server save (`PATCH /api/save/settings`), so they
// follow the account across devices.

export type Quality = 'auto' | 'high' | 'medium' | 'low';
export type AimMode = 'auto' | 'manual';

export interface Settings {
  /** How many effects and particles are drawn; `auto` lowers it when the game stutters. */
  quality: Quality;
  damageNumbers: boolean;
  /** Fewer screen shakes and softer flashes. */
  calmMode: boolean;
  showFps: boolean;
  /** Touch joystick size (how far the finger drags), 0.5–2. */
  stickScale: number;
  /** 0–1. */
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
  /**
   * Attacks aim by themselves (`auto`) or where the player points (`manual`: the mouse, the right
   * touch joystick, the gamepad's right stick). Local only: it depends on the device.
   */
  aimMode: AimMode;
  /**
   * The in-run HUD's size, 0.75–1.5 times its automatic size (which grows with the window). Local
   * only: it depends on the screen.
   */
  hudScale: number;
  /** Placeholder until there are translations: only `en` exists. Local only. */
  language: 'en';
}

/**
 * The fields stored in the server save (its `settings`); `aimMode`, `hudScale` and `language` stay
 * local.
 */
export const SYNCED_KEYS = [
  'quality',
  'damageNumbers',
  'calmMode',
  'showFps',
  'stickScale',
  'musicVolume',
  'sfxVolume',
  'muted',
] as const satisfies readonly (keyof Settings)[];
export type SyncedSettings = Pick<Settings, (typeof SYNCED_KEYS)[number]>;

/** The same defaults as the server save (`DEFAULT_SETTINGS` in apps/server). */
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  quality: 'auto',
  damageNumbers: true,
  calmMode: false,
  showFps: false,
  stickScale: 1,
  musicVolume: 0.55,
  sfxVolume: 0.7,
  muted: false,
  aimMode: 'auto',
  hudScale: 1,
  language: 'en',
};

const STORAGE_KEY = 'ps.settings';

type Listener = (settings: Readonly<Settings>, changed: readonly (keyof Settings)[]) => void;

/** Keeps only known keys with values of the right shape (storage and the server can be stale). */
export function sanitizeSettings(raw: unknown): Partial<Settings> {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (r.quality === 'auto' || r.quality === 'high' || r.quality === 'medium' || r.quality === 'low')
    out.quality = r.quality;
  for (const key of ['damageNumbers', 'calmMode', 'showFps', 'muted'] as const)
    if (typeof r[key] === 'boolean') out[key] = r[key];
  const num = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
  const stick = num(r.stickScale, 0.5, 2);
  if (stick !== undefined) out.stickScale = stick;
  const music = num(r.musicVolume, 0, 1);
  if (music !== undefined) out.musicVolume = music;
  const sfx = num(r.sfxVolume, 0, 1);
  if (sfx !== undefined) out.sfxVolume = sfx;
  if (r.aimMode === 'auto' || r.aimMode === 'manual') out.aimMode = r.aimMode;
  const hud = num(r.hudScale, 0.75, 1.5);
  if (hud !== undefined) out.hudScale = hud;
  if (r.language === 'en') out.language = 'en';
  return out;
}

export class SettingsStore {
  private value: Settings;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    let stored: unknown;
    try {
      stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    } catch {
      stored = null;
    }
    this.value = { ...DEFAULT_SETTINGS, ...sanitizeSettings(stored) };
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  /** Changes some settings and tells the subscribers which ones changed. */
  set(patch: Partial<Settings>): void {
    const clean = sanitizeSettings(patch);
    const changed = (Object.keys(clean) as (keyof Settings)[]).filter(
      (k) => clean[k] !== this.value[k],
    );
    if (changed.length === 0) return;
    this.value = { ...this.value, ...clean };
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Storage full or blocked (private mode): the settings still apply for this session.
    }
    for (const fn of this.listeners) fn(this.value, changed);
  }

  /** Calls `fn` on every change. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The fields the server save stores. */
  synced(): SyncedSettings {
    return Object.fromEntries(SYNCED_KEYS.map((k) => [k, this.value[k]])) as SyncedSettings;
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The app's settings. */
export const settings = new SettingsStore(browserStorage());

/** Effective volume (0–1) of music or sound effects, with mute applied. */
export function volumeOf(kind: 'music' | 'sfx', s: Readonly<Settings> = settings.get()): number {
  if (s.muted) return 0;
  return kind === 'music' ? s.musicVolume : s.sfxVolume;
}
