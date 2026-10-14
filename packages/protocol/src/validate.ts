// Validation of everything a client sends. The server never trusts a client message's shape:
// anything that doesn't match exactly is rejected (with the request id, if one could be read).
import { AIM_STEPS } from './messages.js';
import type {
  ClientMessage,
  IntentValue,
  MemberStatus,
  ServerMessage,
  WireIntent,
} from './messages.js';

export type Decoded<T> =
  { ok: true; message: T } | { ok: false; rid: number | null; reason: string };

const MEMBER_STATUSES: readonly MemberStatus[] = ['ready', 'not-ready', 'busy'];
/** Intents: at most this many fields besides `type`, with short keys and values. */
const MAX_INTENT_FIELDS = 8;
const MAX_INTENT_STRING = 64;
const MAX_KEY = 32;
const MAX_INTENT_ARRAY = 8;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

function parse(raw: string): Obj | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

/** Only the listed keys (plus `type` and `rid`) may be present. */
function onlyKeys(m: Obj, keys: readonly string[]): boolean {
  for (const k of Object.keys(m))
    if (k !== 'type' && k !== 'rid' && !keys.includes(k)) return false;
  return true;
}

function intentValue(value: unknown): value is IntentValue {
  return (
    value === null ||
    typeof value === 'boolean' ||
    isFinite(value) ||
    (typeof value === 'string' && value.length <= MAX_INTENT_STRING)
  );
}

export function validateIntent(v: unknown): WireIntent | null {
  if (!isObj(v) || !isStr(v.type, MAX_KEY)) return null;
  const keys = Object.keys(v);
  if (keys.length > MAX_INTENT_FIELDS + 1) return null;
  const out: WireIntent = { type: v.type };
  for (const k of keys) {
    if (k === 'type') continue;
    if (k.length > MAX_KEY || k === '__proto__') return null;
    const value = v[k];
    if (intentValue(value)) out[k] = value;
    else if (
      Array.isArray(value) &&
      value.length <= MAX_INTENT_ARRAY &&
      value.every((x) => intentValue(x) && !Array.isArray(x))
    )
      out[k] = value as IntentValue[];
    else return null;
  }
  return out;
}

function request(m: Obj, rid: number): ClientMessage | string {
  switch (m.type) {
    case 'room.create':
    case 'room.leave':
    case 'room.start':
      return onlyKeys(m, []) ? { type: m.type, rid } : 'unexpected fields';
    case 'room.invite':
      return isStr(m.username, 64) && onlyKeys(m, ['username'])
        ? { type: m.type, rid, username: m.username }
        : 'bad username';
    case 'room.join':
    case 'invite.decline':
      return isStr(m.roomId, 64) && onlyKeys(m, ['roomId'])
        ? { type: m.type, rid, roomId: m.roomId }
        : 'bad roomId';
    case 'room.kick':
      return isStr(m.userId, 64) && onlyKeys(m, ['userId'])
        ? { type: m.type, rid, userId: m.userId }
        : 'bad userId';
    case 'room.status':
      return MEMBER_STATUSES.includes(m.status as MemberStatus) && onlyKeys(m, ['status'])
        ? { type: m.type, rid, status: m.status as MemberStatus }
        : 'bad status';
    case 'intent': {
      const intent = validateIntent(m.intent);
      return intent && isStr(m.gameId, 64) && onlyKeys(m, ['gameId', 'intent'])
        ? { type: 'intent', rid, gameId: m.gameId, intent }
        : 'bad intent';
    }
    default:
      return 'unknown message type';
  }
}

export function decodeClientMessage(raw: string): Decoded<ClientMessage> {
  const m = parse(raw);
  if (!m || typeof m.type !== 'string') return { ok: false, rid: null, reason: 'not a message' };
  const fail = (reason: string, rid: number | null = null) => ({ ok: false as const, rid, reason });
  switch (m.type) {
    case 'hello':
      return isUint(m.protocolVersion)
        ? { ok: true, message: { type: 'hello', protocolVersion: m.protocolVersion } }
        : fail('bad hello');
    case 'ping':
      return isUint(m.id) && isFinite(m.sentAt) && onlyKeys(m, ['id', 'sentAt'])
        ? { ok: true, message: { type: 'ping', id: m.id, sentAt: m.sentAt } }
        : fail('bad ping');
    case 'game.loaded':
    case 'game.resync':
      return isStr(m.gameId, 64) && onlyKeys(m, ['gameId'])
        ? { ok: true, message: { type: m.type, gameId: m.gameId } }
        : fail(`bad ${m.type}`);
    case 'activity': {
      const solo = m.solo;
      if (!onlyKeys(m, ['solo'])) return fail('bad activity');
      if (solo === null) return { ok: true, message: { type: 'activity', solo: null } };
      if (
        !isObj(solo) ||
        !isStr(solo.runId, 64) ||
        !isFinite(solo.elapsedS) ||
        solo.elapsedS < 0 ||
        typeof solo.paused !== 'boolean' ||
        Object.keys(solo).some((k) => !['runId', 'elapsedS', 'paused'].includes(k))
      )
        return fail('bad activity');
      return {
        ok: true,
        message: {
          type: 'activity',
          solo: { runId: solo.runId, elapsedS: solo.elapsedS, paused: solo.paused },
        },
      };
    }
    case 'input': {
      const slot = m.slot;
      const slotOk = slot === undefined || slot === null || (isUint(slot) && slot < 16);
      const aim = m.aim;
      const aimOk = aim === undefined || (isUint(aim) && aim < AIM_STEPS);
      // Fire held only means something with a manual aim.
      const fireOk = m.fire === undefined || (m.fire === true && aim !== undefined);
      if (
        !isStr(m.gameId, 64) ||
        !isUint(m.seq) ||
        !isFinite(m.moveX) ||
        !isFinite(m.moveY) ||
        !slotOk ||
        !aimOk ||
        !fireOk ||
        !onlyKeys(m, ['gameId', 'seq', 'moveX', 'moveY', 'slot', 'aim', 'fire'])
      )
        return fail('bad input');
      const clamp = (v: number) => Math.max(-1, Math.min(1, v));
      return {
        ok: true,
        message: {
          type: 'input',
          gameId: m.gameId,
          seq: m.seq,
          moveX: clamp(m.moveX),
          moveY: clamp(m.moveY),
          ...(slot !== undefined ? { slot } : {}),
          ...(aim !== undefined ? { aim } : {}),
          ...(m.fire === true ? { fire: true as const } : {}),
        },
      };
    }
    default: {
      if (!isUint(m.rid)) return fail('requests need a numeric rid');
      const result = request(m, m.rid);
      return typeof result === 'string' ? fail(result, m.rid) : { ok: true, message: result };
    }
  }
}

/** Text frames from the server. Trusted (it's our server): only the envelope is checked. */
export function decodeServerMessage(raw: string): ServerMessage | null {
  const m = parse(raw);
  return m && typeof m.type === 'string' ? (m as unknown as ServerMessage) : null;
}

/** Any message (generic messages carry the sim's types, which plain JSON handles). */
export function encode(message: object): string {
  return JSON.stringify(message);
}
