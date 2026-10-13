// Events: what happened this tick, for the client to turn into sound, VFX and text. They are
// cosmetic or notifications only: gameplay never depends on them being delivered (everything that
// matters is in the state). Text is an i18n key from packages/data/i18n/en.json plus params.
import type { PickupKind, PlayerId, EntityId, BossSkill } from './state.js';
import type { MoveKind, PokemonType, UiStringKey } from '@pokesurvivor/data';

/** 'super' / 'weak': type effectiveness; 'crit': critical hit. */
export type HitLabel = 'super' | 'weak' | 'crit' | null;

export type ProgressEventName = 'defeat' | 'chest' | 'item' | 'evolve' | 'rift-win' | 'run-end';

export type SimEvent =
  /** A banner message. `playerId`: only for that player (otherwise everyone). */
  | {
      type: 'say';
      key: UiStringKey;
      params?: Record<string, string | number>;
      seconds: number;
      playerId?: PlayerId;
    }
  /** A move was cast. Kind-specific geometry for the visuals in `beamLength`, `to`, `chain`. */
  | {
      type: 'cast';
      playerId: PlayerId;
      moveId: string;
      kind: MoveKind;
      moveType: PokemonType;
      x: number;
      y: number;
      aim: number;
      /** Beam: length up to the first wall. Dash: distance travelled. */
      length?: number;
      /** Chain: the enemies hit, in order. */
      chain?: { x: number; y: number }[];
    }
  | { type: 'slot'; playerId: PlayerId; slot: number }
  /** Switching moves is locked (Choice Band). */
  | { type: 'slot-locked'; playerId: PlayerId; itemId: string }
  | {
      type: 'enemy-hurt';
      id: EntityId;
      x: number;
      y: number;
      amount: number;
      label: HitLabel;
      /** The shield absorbed it all. */
      shielded: boolean;
      byPlayer: PlayerId | null;
    }
  | {
      type: 'enemy-died';
      id: EntityId;
      dex: number;
      x: number;
      y: number;
      boss: boolean;
      shiny: boolean;
    }
  | { type: 'enemy-spawned'; id: EntityId; dex: number; boss: boolean; shiny: boolean }
  /** An enemy left without dying (straggler that found no room ahead). */
  | { type: 'enemy-removed'; id: EntityId }
  /** Enemy animation cues: an attack, a support skill, a boss skill wind-up. */
  | {
      type: 'enemy-action';
      id: EntityId;
      action:
        | 'shoot'
        | 'charge'
        | 'dash'
        | 'strike'
        | 'heal'
        | 'shield'
        | 'summon'
        | 'jump'
        | 'land'
        | 'fuse'
        | 'enrage';
      skill?: BossSkill;
    }
  | { type: 'hazard'; id: EntityId; phase: 'warn' | 'hit' }
  | { type: 'player-hurt'; playerId: PlayerId; amount: number; label: HitLabel }
  | { type: 'player-healed'; playerId: PlayerId; amount: number }
  | { type: 'player-down'; playerId: PlayerId }
  | { type: 'player-revived'; playerId: PlayerId; by: PlayerId | null }
  | { type: 'focus-sash'; playerId: PlayerId }
  | { type: 'pickup'; playerId: PlayerId; kind: PickupKind; x: number; y: number; value: number }
  | { type: 'bomb'; playerId: PlayerId; x: number; y: number }
  | { type: 'magnet'; playerId: PlayerId }
  | { type: 'prop-broken'; key: string; propType: string; x: number; y: number }
  | { type: 'prop-hit'; key: string; x: number; y: number }
  | { type: 'field-blast'; id: EntityId; x: number; y: number; r: number }
  | { type: 'biome'; index: number; biomeId: string }
  /** The team levelled up (cards follow as pending choices). */
  | { type: 'level-up'; level: number }
  | { type: 'move-learned'; playerId: PlayerId; moveId: string }
  | { type: 'move-upgraded'; playerId: PlayerId; moveId: string; level: number }
  | { type: 'move-evolved'; playerId: PlayerId; moveId: string }
  | { type: 'item-equipped'; playerId: PlayerId; itemId: string }
  | { type: 'shiny-caught'; dex: number }
  /** For missions/achievements. `playerId` null: counts for every player. */
  | {
      type: 'progress';
      event: ProgressEventName;
      playerId: PlayerId | null;
      data: Record<string, unknown>;
    }
  | { type: 'choice-resolved'; playerId: PlayerId; choiceId: number; auto: boolean }
  | { type: 'run-ended'; reason: 'all-down' | 'everyone-left' };

export type SimEventType = SimEvent['type'];
