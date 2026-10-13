// Which sim events a client gets. Events are cosmetic (sounds, numbers, VFX, banners), so this
// only saves bandwidth: it works on the events' shape, not on a list of types, so events the sim
// adds later pass through unless they're clearly someone else's or far away.
import type { SimEvent } from '@pokesurvivor/sim';

/** Event types that only matter to the player named in `playerId` (when it's set). */
const PERSONAL = new Set(['say', 'progress', 'slot', 'slot-locked']);

export interface EventViewer {
  viewerId: string;
  x: number;
  y: number;
  radius: number;
  /** Is this entity id (enemy, projectile, field, hazard) in the viewer's snapshot? */
  visible(id: number): boolean;
}

type Loose = Record<string, unknown>;

export function isRelevant(e: SimEvent, v: EventViewer): boolean {
  const ev = e as unknown as Loose;
  const playerId = typeof ev.playerId === 'string' ? ev.playerId : null;
  if (playerId === v.viewerId) return true;
  if (playerId !== null && PERSONAL.has(e.type)) return false;
  if (typeof ev.x === 'number' && typeof ev.y === 'number')
    return (ev.x - v.x) ** 2 + (ev.y - v.y) ** 2 <= v.radius ** 2;
  if (typeof ev.id === 'number') return v.visible(ev.id);
  return true;
}

/** Rounds numbers to 0.1 (positions, amounts): the client draws them, it doesn't simulate. */
function round(value: unknown): unknown {
  if (typeof value === 'number')
    return Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === 'object') {
    const out: Loose = {};
    for (const [k, v] of Object.entries(value)) out[k] = round(v);
    return out;
  }
  return value;
}

export function filterEvents(events: readonly SimEvent[], viewer: EventViewer): SimEvent[] {
  return events.filter((e) => isRelevant(e, viewer));
}

// ------------------------------------------------------------------ compact encoding
//
// Events are written into the binary frame by shape: the first time a connection sees a given
// type with a given set of keys, the shape (type + keys) goes in the frame's JSON part with a
// new index; after that an event is its shape index plus one tagged value per key. Strings go
// through the snapshot's string table. Nested values (chains, params) fall back to JSON.

const Tag = {
  null: 0,
  false: 1,
  true: 2,
  int: 3,
  /** A number with one decimal, ×10. */
  tenths: 4,
  string: 5,
  json: 6,
  undefined: 7,
} as const;

export type Shape = [type: string, ...keys: string[]];

interface ValueWriter {
  uint(n: number): void;
  int(n: number): void;
  str(s: string): void;
}

interface ValueReader {
  uint(): number;
  int(): number;
  str(): string;
}

export class EventEncoder {
  private shapes = new Map<string, number>();

  constructor(private readonly strings: (s: string) => number) {}

  reset(): void {
    this.shapes.clear();
  }

  /** Writes the events; returns the shapes first used here (index → shape) for the JSON part. */
  write(w: ValueWriter, events: readonly SimEvent[]): Record<number, Shape> | undefined {
    let added: Record<number, Shape> | undefined;
    w.uint(events.length);
    for (const e of events) {
      const ev = e as unknown as Loose;
      const keys = Object.keys(ev).filter((k) => k !== 'type');
      const key = `${e.type}\u0000${keys.join('\u0000')}`;
      let index = this.shapes.get(key);
      if (index === undefined) {
        index = this.shapes.size + 1;
        this.shapes.set(key, index);
        (added ??= {})[index] = [e.type, ...keys];
      }
      w.uint(index);
      for (const k of keys) this.value(w, ev[k]);
    }
    return added;
  }

  private value(w: ValueWriter, v: unknown): void {
    if (v === null) w.uint(Tag.null);
    else if (v === undefined) w.uint(Tag.undefined);
    else if (v === false) w.uint(Tag.false);
    else if (v === true) w.uint(Tag.true);
    else if (typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) < 2 ** 50) {
      w.uint(Tag.int);
      w.int(v);
    } else if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 2 ** 46) {
      w.uint(Tag.tenths);
      w.int(Math.round(v * 10));
    } else if (typeof v === 'string') {
      w.uint(Tag.string);
      w.uint(this.strings(v));
    } else {
      w.uint(Tag.json);
      w.str(JSON.stringify(round(v)) ?? 'null');
    }
  }
}

export class EventDecoder {
  private shapes = new Map<number, Shape>();

  reset(): void {
    this.shapes.clear();
  }

  addShapes(shapes: Record<number, Shape> | undefined): void {
    for (const [i, shape] of Object.entries(shapes ?? {})) this.shapes.set(Number(i), shape);
  }

  read(r: ValueReader, strings: (i: number) => string | null): SimEvent[] {
    const out: SimEvent[] = [];
    for (let n = r.uint(); n > 0; n--) {
      const index = r.uint();
      const shape = this.shapes.get(index);
      if (!shape) throw new Error(`unknown event shape ${index}`);
      const [type, ...keys] = shape;
      const e: Loose = { type };
      for (const k of keys) {
        const v = this.value(r, strings);
        if (v !== undefined) e[k] = v;
      }
      out.push(e as unknown as SimEvent);
    }
    return out;
  }

  private value(r: ValueReader, strings: (i: number) => string | null): unknown {
    const tag = r.uint();
    switch (tag) {
      case Tag.null:
        return null;
      case Tag.undefined:
        return undefined;
      case Tag.false:
        return false;
      case Tag.true:
        return true;
      case Tag.int:
        return r.int();
      case Tag.tenths:
        return r.int() / 10;
      case Tag.string:
        return strings(r.uint()) ?? '';
      case Tag.json:
        return JSON.parse(r.str()) as unknown;
      default:
        throw new Error(`bad event value tag ${String(tag)}`);
    }
  }
}
