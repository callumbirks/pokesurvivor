import { describe, expect, it } from 'vitest';
import {
  AIM_STEPS,
  BinaryReader,
  BinaryWriter,
  JsonReader,
  JsonWriter,
  TableDecoder,
  TableEncoder,
  decodeAim,
  decodeClientMessage,
  encode,
  encodeAim,
  quantizeAim,
  readFrame,
  validateIntent,
  writeFrame,
} from './index.js';
import type { Reader, Rows, Writer } from './index.js';

describe('client messages', () => {
  it('accepts well-formed messages', () => {
    for (const m of [
      { type: 'hello', protocolVersion: 2 },
      { type: 'ping', id: 7, sentAt: 123.5 },
      { type: 'input', gameId: 'g', seq: 3, moveX: 0.5, moveY: -1, slot: 2 },
      { type: 'input', gameId: 'g', seq: 4, moveX: 0, moveY: 0, aim: 0 },
      { type: 'input', gameId: 'g', seq: 5, moveX: 0, moveY: 0, slot: null, aim: 255 },
      { type: 'room.create', rid: 1 },
      { type: 'room.invite', rid: 2, username: 'misty' },
      { type: 'room.status', rid: 3, status: 'busy' },
      {
        type: 'intent',
        gameId: 'g',
        rid: 4,
        intent: { type: 'pickCard', choiceId: 3, cardId: 'new:ember' },
      },
      {
        type: 'intent',
        gameId: 'g',
        rid: 5,
        intent: { type: 'someFutureIntent', flag: true, n: null },
      },
      {
        type: 'intent',
        gameId: 'g',
        rid: 6,
        intent: { type: 'pickBond', choiceId: 2, moves: ['ember', 'tackle'] },
      },
    ]) {
      expect(decodeClientMessage(encode(m))).toEqual({ ok: true, message: m });
    }
  });

  it('clamps movement', () => {
    const d = decodeClientMessage(
      encode({ type: 'input', gameId: 'g', seq: 1, moveX: 5, moveY: -9 }),
    );
    expect(d).toMatchObject({ ok: true, message: { moveX: 1, moveY: -1 } });
  });

  it('rejects malformed messages, keeping the request id when it can', () => {
    expect(decodeClientMessage('not json')).toMatchObject({ ok: false, rid: null });
    expect(decodeClientMessage('{"type":"ping"}')).toMatchObject({ ok: false });
    expect(decodeClientMessage('{"type":"room.create"}')).toMatchObject({ ok: false, rid: null });
    for (const bad of [
      { type: 'intent', rid: 9, intent: { type: 'pickCard', choiceId: 1, cardId: 'x' } },
      { type: 'room.status', rid: 9, status: 'afk' },
      { type: 'room.invite', rid: 9, username: '' },
      { type: 'room.create', rid: 9, extra: 1 },
      { type: 'nope', rid: 9 },
      { type: 'intent', gameId: 'g', rid: 9, intent: { type: 'pickCard', cardId: { nested: 1 } } },
      { type: 'intent', gameId: 'g', rid: 9, intent: { choiceId: 1 } },
    ]) {
      expect(decodeClientMessage(encode(bad))).toMatchObject({ ok: false, rid: 9 });
    }
    for (const bad of [
      { type: 'input', seq: 1, moveX: 0, moveY: 0 },
      { type: 'input', gameId: 'g', seq: -1, moveX: 0, moveY: 0 },
      { type: 'input', gameId: 'g', seq: 1, moveX: 'a', moveY: 0 },
      { type: 'input', gameId: 'g', seq: 1, moveX: 0, moveY: 0, slot: 1.5 },
      { type: 'input', gameId: 'g', seq: 1, moveX: 0, moveY: 0, aim: 256 },
      { type: 'input', gameId: 'g', seq: 1, moveX: 0, moveY: 0, aim: -1 },
      { type: 'input', gameId: 'g', seq: 1, moveX: 0, moveY: 0, aim: 1.5 },
      { type: 'input', gameId: 'g', seq: 1, moveX: 0, moveY: 0, aim: null },
    ]) {
      expect(decodeClientMessage(encode(bad)).ok).toBe(false);
    }
  });

  it('round-trips the aim, quantised to a byte', () => {
    const gap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    for (const angle of [0, 1, -1, Math.PI, -Math.PI, Math.PI / 2, 3, -3, 7, -7, 2 * Math.PI]) {
      const aim = encodeAim(angle);
      expect(Number.isInteger(aim) && aim >= 0 && aim < AIM_STEPS).toBe(true);
      const d = decodeClientMessage(
        encode({ type: 'input', gameId: 'g', seq: 1, moveX: 0, moveY: 0, aim }),
      );
      expect(d).toMatchObject({ ok: true, message: { aim } });
      const back = decodeAim(d.ok && d.message.type === 'input' ? (d.message.aim ?? -1) : -1);
      expect(gap(back, angle)).toBeLessThanOrEqual(Math.PI / AIM_STEPS + 1e-9);
      expect(back).toBeGreaterThan(-Math.PI);
      expect(back).toBeLessThanOrEqual(Math.PI);
      expect(quantizeAim(back)).toBe(back);
    }
    expect(encodeAim(0)).toBe(0);
    expect(encodeAim(Math.PI / 2)).toBe(64);
    expect(encodeAim(-Math.PI / 2)).toBe(192);
  });

  it('limits intents to a few primitive fields', () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    expect(validateIntent({ type: 'x', ...many })).toBeNull();
    expect(validateIntent({ type: 'x', s: 'a'.repeat(65) })).toBeNull();
    expect(validateIntent({ type: 'x', n: Infinity })).toBeNull();
    expect(validateIntent({ type: 'x', a: [[1]] })).toBeNull();
    expect(validateIntent({ type: 'x', a: Array(9).fill('m') })).toBeNull();
    expect(validateIntent(JSON.parse('{"type":"x","__proto__":{"a":1}}'))).toBeNull();
  });
});

describe('wire', () => {
  it('round-trips varints, signed ints and strings', () => {
    const values = [0, 1, 127, 128, 300, 2 ** 31, 2 ** 40 + 5, Number.MAX_SAFE_INTEGER];
    const w = new BinaryWriter();
    for (const v of values) w.uint(v);
    const signed = values.slice(1, -1);
    for (const v of signed) w.int(-v);
    w.str('héllo ✨');
    const r = new BinaryReader(w.finish());
    expect(values.map(() => r.uint())).toEqual(values);
    expect(signed.map(() => r.int())).toEqual(signed.map((v) => -v));
    expect(r.str()).toBe('héllo ✨');
    expect(r.done).toBe(true);
  });
});

describe('tables', () => {
  const variants: [string, () => { w: Writer; read: () => Reader }][] = [
    [
      'binary',
      () => {
        const w = new BinaryWriter();
        return { w, read: () => new BinaryReader(w.finish()) };
      },
    ],
    [
      'json',
      () => {
        const w = new JsonWriter();
        return { w, read: () => new JsonReader(JSON.parse(w.finish()) as number[]) };
      },
    ],
  ];

  for (const [name, make] of variants) {
    it(`sends only changes and stays in sync (${name})`, () => {
      const enc = new TableEncoder(3);
      const dec = new TableDecoder(3);
      const frames: Rows[] = [
        new Map([
          [5, [1, 2, 3]],
          [9, [-4, 0, 7]],
        ]),
        new Map([
          [5, [1, 2, 3]],
          [9, [-4, 1, 7]],
          [12, [0, 0, 0]],
        ]),
        new Map([[12, [100000, -(2 ** 40), 1]]]),
        new Map(),
      ];
      const sizes: number[] = [];
      for (const rows of frames) {
        const { w, read } = make();
        writeFrame(w, [42], [{ encoder: enc, rows }], '{"x":1}');
        const frame = readFrame(read(), [dec]);
        expect(frame.header).toEqual([42]);
        expect(frame.json).toBe('{"x":1}');
        expect(new Map(dec.rows)).toEqual(new Map([...rows].map(([k, v]) => [k, [...v]])));
        if (w instanceof BinaryWriter) sizes.push(w.length);
      }
      if (sizes.length) expect(sizes[1]).toBeLessThan(sizes[0]!);
    });
  }

  it('resends everything after a reset', () => {
    const enc = new TableEncoder(1);
    const rows = new Map([[1, [5]]]);
    const first = new BinaryWriter();
    enc.encode(first, rows);
    const again = new BinaryWriter();
    enc.encode(again, rows);
    enc.reset();
    const full = new BinaryWriter();
    enc.encode(full, rows);
    expect(again.length).toBeLessThan(first.length);
    expect(full.finish()).toEqual(first.finish());
  });
});
