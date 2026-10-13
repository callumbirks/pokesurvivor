// Delta-compressed entity tables: the core of snapshot frames. A table is a set of rows keyed by
// an integer id; each row is a fixed-width list of integers (already quantized by the caller).
// The encoder remembers what it last sent to one client and writes only what changed: removed
// ids, added rows in full, and for updated rows a bitmask of the changed fields plus their
// deltas. WebSockets are reliable and ordered, so "last sent" is what the client has; a client
// that reconnects gets a full frame (`reset()` on the encoder).
import type { Reader, Writer } from './wire.js';

export type Row = readonly number[];
export type Rows = ReadonlyMap<number, Row>;

/** Fields per row are limited so the change mask stays a small varint. */
export const MAX_TABLE_WIDTH = 30;

function writeIds(w: Writer, ids: readonly number[]): void {
  w.uint(ids.length);
  let prev = 0;
  for (const id of ids) {
    w.int(id - prev);
    prev = id;
  }
}

function readIds(r: Reader): number[] {
  const n = r.uint();
  const ids: number[] = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += r.int();
    ids.push(prev);
  }
  return ids;
}

const byId = (a: number, b: number) => a - b;

export class TableEncoder {
  private sent = new Map<number, number[]>();

  constructor(readonly width: number) {
    if (width < 1 || width > MAX_TABLE_WIDTH) throw new RangeError(`bad table width ${width}`);
  }

  /** Forget what was sent: the next `encode` sends every row as new. */
  reset(): void {
    this.sent.clear();
  }

  encode(w: Writer, rows: Rows): void {
    const removed: number[] = [];
    for (const id of this.sent.keys()) if (!rows.has(id)) removed.push(id);
    removed.sort(byId);
    for (const id of removed) this.sent.delete(id);

    const added: number[] = [];
    const updated: { id: number; mask: number; row: Row; prev: number[] }[] = [];
    for (const id of [...rows.keys()].sort(byId)) {
      const row = rows.get(id) as Row;
      if (row.length !== this.width) throw new RangeError(`row ${id} has ${row.length} fields`);
      const prev = this.sent.get(id);
      if (!prev) {
        added.push(id);
        continue;
      }
      let mask = 0;
      for (let i = 0; i < this.width; i++) if (row[i] !== prev[i]) mask += 2 ** i;
      if (mask) updated.push({ id, mask, row, prev });
    }

    writeIds(w, removed);
    writeIds(w, added);
    for (const id of added) {
      const row = rows.get(id) as Row;
      for (const v of row) w.int(v);
      this.sent.set(id, [...row]);
    }
    writeIds(
      w,
      updated.map((u) => u.id),
    );
    for (const { mask, row, prev } of updated) {
      w.uint(mask);
      for (let i = 0; i < this.width; i++) {
        const v = row[i] as number;
        if (v !== prev[i]) {
          w.int(v - (prev[i] as number));
          prev[i] = v;
        }
      }
    }
  }
}

export interface TableChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

export class TableDecoder {
  readonly rows = new Map<number, number[]>();

  constructor(readonly width: number) {}

  reset(): void {
    this.rows.clear();
  }

  decode(r: Reader): TableChanges {
    const removed = readIds(r);
    for (const id of removed) this.rows.delete(id);
    const added = readIds(r);
    for (const id of added) {
      const row: number[] = [];
      for (let i = 0; i < this.width; i++) row.push(r.int());
      this.rows.set(id, row);
    }
    const updated = readIds(r);
    for (const id of updated) {
      let mask = r.uint();
      const row = this.rows.get(id);
      if (!row) throw new Error(`update for unknown row ${id}`);
      for (let i = 0; i < this.width; i++, mask = Math.floor(mask / 2)) {
        if (mask % 2) row[i] = (row[i] as number) + r.int();
      }
    }
    return { added, updated, removed };
  }
}

/** First byte of every binary server frame. */
export const FrameKind = { snapshot: 1 } as const;

/**
 * A frame: a few header integers, every table's delta, then a JSON string for the parts that
 * aren't numeric tables (choices, events, rarely-changing details).
 */
export function writeFrame(
  w: Writer,
  header: readonly number[],
  tables: readonly { encoder: TableEncoder; rows: Rows }[],
  json: string,
): void {
  w.uint(header.length);
  for (const v of header) w.int(v);
  w.uint(tables.length);
  for (const t of tables) t.encoder.encode(w, t.rows);
  w.str(json);
}

export interface Frame {
  header: number[];
  changes: TableChanges[];
  json: string;
}

/**
 * Reads a frame into the decoders. `before(header)` runs after the header and before the tables,
 * so a full frame can reset the decoders first.
 */
export function readFrame(
  r: Reader,
  decoders: readonly TableDecoder[],
  before?: (header: number[]) => void,
): Frame {
  const header: number[] = [];
  for (let i = r.uint(); i > 0; i--) header.push(r.int());
  before?.(header);
  const count = r.uint();
  if (count !== decoders.length)
    throw new Error(`frame has ${count} tables, expected ${decoders.length}`);
  const changes = decoders.map((d) => d.decode(r));
  const json = r.str();
  return { header, changes, json };
}
