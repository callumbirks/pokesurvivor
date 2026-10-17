import {
  createSim,
  isAttacking,
  playerMoveSpeed,
  playerStats,
  TICK_HZ,
  type FieldState,
  type SimEvent,
} from '@pokesurvivor/sim';
import { describe, expect, it } from 'vitest';
import { SnapshotBuffer, interpolate, interpolateList, maxStep } from '../src/buffer.js';
import { measureJumps } from './jumps.js';
import { EventDecoder, EventEncoder, isRelevant } from '../src/events.js';
import {
  INTEREST_RADIUS,
  SnapshotDecoder,
  SnapshotEncoder,
  type NetField,
  type Snapshot,
} from '../src/snapshot.js';
import { botStep, lateGame } from './late-game.js';
import { BinaryReader, BinaryWriter } from '@pokesurvivor/protocol';

describe('snapshots', () => {
  const sim = lateGame(3);
  const ids = sim.state.players.map((p) => p.id);

  it('rebuild the viewer’s view of the state, within quantization', () => {
    const enc = new SnapshotEncoder({ viewerId: 'p1' });
    const dec = new SnapshotDecoder(ids);
    let snap: Snapshot | null = null;
    for (let i = 0; i < 60; i++) {
      botStep(sim);
      snap = dec.decode(enc.encode(sim.state, sim.drainEvents(), i + 1, i * 2));
      expect(snap.full).toBe(i === 0);
    }
    const s = sim.state;
    const me = s.players[1]!;
    expect(snap!.seq).toBe(60);
    expect(snap!.ackSeq).toBe(118);
    expect(snap!.tick).toBe(s.tick);
    expect(snap!.time).toBeCloseTo(s.time, 2);
    expect(snap!.players.map((p) => [p.id, p.x, p.y, p.hp])).toEqual(
      s.players.map((p) => [
        p.id,
        expect.closeTo(p.x, 0) as unknown,
        expect.closeTo(p.y, 0) as unknown,
        Math.ceil(p.hp),
      ]),
    );
    const near = s.enemies.filter((e) => Math.hypot(e.x - me.x, e.y - me.y) <= INTEREST_RADIUS);
    const got = new Map(snap!.enemies.map((e) => [e.id, e]));
    for (const e of near) {
      const n = got.get(e.id);
      expect(n, `enemy ${e.id}`).toBeDefined();
      expect(n!.dex).toBe(e.dex);
      expect(Math.abs(n!.x - e.x)).toBeLessThanOrEqual(0.25);
      expect(n!.boss).toBe(e.boss);
      expect(n!.behavior).toBe(e.behavior);
    }
    // Nothing far away (beyond the hysteresis band).
    for (const n of snap!.enemies) {
      const e = s.enemies.find((x) => x.id === n.id)!;
      expect(Math.hypot(e.x - me.x, e.y - me.y)).toBeLessThanOrEqual(INTEREST_RADIUS + 150);
    }
    expect(snap!.team.level).toBe(s.team.level);
    // Who's attacking (they face their aim: `facingOf`).
    expect(snap!.players.map((p) => p.attacking)).toEqual(
      s.players.map((p) => isAttacking(s.time, p)),
    );
    expect(s.players.some((p) => isAttacking(s.time, p))).toBe(true);
    expect(snap!.details.p1?.moves.map((m) => m.id)).toEqual(me.moves.map((m) => m.id));
    expect(snap!.details.p1?.buffs).toEqual([
      me.buffs.attack.n,
      me.buffs.speed.n,
      me.buffs.defense.n,
      me.buffs.regen.n,
    ]);
    // The viewer's own cooldowns (one per move, 0–1) and its speed for prediction.
    expect(snap!.self?.cooldowns).toHaveLength(me.moves.length);
    for (const c of snap!.self!.cooldowns) expect(c >= 0 && c <= 1).toBe(true);
    // The seeded build can now choose Agility: prediction must include buffs/traps/weather.
    expect(snap!.self?.speed).toBeCloseTo(playerMoveSpeed(s, me), -1);
    expect(snap!.self?.momentum).toBeCloseTo(me.momentum, 1);
    expect(Object.keys(snap!.world.broken ?? {}).sort()).toEqual(
      Object.keys(s.world.broken).sort(),
    );
  });

  it('carry rifts, the arena, weather and world records when they change', () => {
    const local = lateGame(1, 11);
    const enc = new SnapshotEncoder({ viewerId: 'p0' });
    const dec = new SnapshotDecoder(local.state.players.map((p) => p.id));
    const next = () =>
      dec.decode(enc.encode(local.state, local.drainEvents(), local.state.tick, 0));
    expect(next().misc.rift).toBeNull();
    local.debugOpenRift();
    local.debugStartWeather('rain', 60);
    local.state.world.springs['3,4'] = 0.25;
    botStep(local);
    const snap = next();
    expect(snap.misc.rift).toMatchObject({ x: expect.any(Number) as unknown });
    expect(snap.misc.weather).toMatchObject({ kind: 'rain' });
    expect(snap.world.springs).toMatchObject({ '3,4': 0.25 });
    delete local.state.world.springs['3,4'];
    local.debugStartArena();
    botStep(local);
    const inArena = next();
    expect(inArena.world.springs?.['3,4']).toBeUndefined();
    expect(inArena.misc.arena).toMatchObject({
      dex: local.state.arena!.dex,
      r: local.state.arena!.r,
    });
  });

  it.each(['binary', 'json'] as const)(
    'carries shield HP in full and delta %s snapshots',
    (format) => {
      const local = lateGame(1, 11);
      const enemy = local.state.enemies[0]!;
      const me = local.state.players[0]!;
      enemy.x = me.x + 40;
      enemy.y = me.y;
      const enc = new SnapshotEncoder({ viewerId: me.id, format });
      const dec = new SnapshotDecoder([me.id]);
      let seq = 0;
      const next = () => dec.decode(enc.encode(local.state, [], ++seq, 0));
      enemy.shield = 123.4;
      expect(next().enemies.find((e) => e.id === enemy.id)).toMatchObject({
        shielded: true,
        shield: 124,
      });
      enemy.shield = 20.5;
      expect(next().enemies.find((e) => e.id === enemy.id)).toMatchObject({
        shielded: true,
        shield: 21,
      });
      enemy.shield = 0;
      expect(next().enemies.find((e) => e.id === enemy.id)).toMatchObject({
        shielded: false,
        shield: 0,
      });
    },
  );

  it('mark the 3-2-1 after a rift paused, with the whole seconds left', () => {
    const s = structuredClone(sim.state);
    const enc = new SnapshotEncoder({ viewerId: 'p1' });
    const dec = new SnapshotDecoder(ids);
    s.resumeTicks = Math.round(2.5 * TICK_HZ);
    const counting = dec.decode(enc.encode(s, [], 1, 0));
    expect(counting.paused).toBe(true);
    expect(counting.misc.resume).toBe(3);
    s.resumeTicks = 0;
    const playing = dec.decode(enc.encode(s, [], 2, 0));
    expect(playing.paused).toBe(false);
    expect(playing.misc.resume).toBeUndefined();
  });

  it('list every pending choice, the viewer’s own in full', () => {
    const s = structuredClone(sim.state);
    s.pendingChoices = [
      {
        id: 1,
        playerId: 'p0',
        kind: 'item',
        held: 'leftovers',
        found: 'life-orb',
        deadlineTick: 50,
      },
      {
        id: 2,
        playerId: 'p1',
        kind: 'item',
        held: 'leftovers',
        found: 'shell-bell',
        deadlineTick: 50,
      },
    ];
    const snap = new SnapshotDecoder(ids).decode(
      new SnapshotEncoder({ viewerId: 'p1' }).encode(s, [], 1, 0),
    );
    expect(snap.paused).toBe(true);
    expect(snap.choices).toEqual([s.pendingChoices[1]]);
    expect(snap.waiting.map((c) => [c.id, c.playerId, c.kind, c.deadlineTick])).toEqual([
      [1, 'p0', 'item', 50],
      [2, 'p1', 'item', 50],
    ]);
  });

  it('send the viewer its Momentum stacks, in both formats', () => {
    const me = sim.state.players[2]!;
    const saved = me.momentum;
    me.momentum = 12.34;
    for (const format of ['binary', 'json'] as const) {
      const enc = new SnapshotEncoder({ viewerId: me.id, format });
      const snap = new SnapshotDecoder(ids).decode(enc.encode(sim.state, [], 1, 0));
      expect(snap.self?.momentum).toBe(12.3);
    }
    me.momentum = saved;
  });

  it('send the viewer only its own stats panel, when it changes, at most twice a second', () => {
    const me = sim.state.players[1]!;
    const enc = new SnapshotEncoder({ viewerId: me.id, format: 'json' });
    const dec = new SnapshotDecoder(ids);
    const frame = (seq: number) => enc.encode(sim.state, [], seq, 0) as string;
    const first = frame(1);
    const snap = dec.decode(first);
    const want = playerStats(sim.state, me);
    expect(snap.stats?.attackBase).toBe(want.attackBase);
    expect(snap.stats?.attack).toBeCloseTo(want.attack, 1);
    expect(snap.stats?.maxHp).toBe(Math.round(want.maxHp));
    expect(snap.stats?.cooldown).toBeCloseTo(want.cooldown, 3);
    // One block, the viewer's: nothing about teammates.
    expect(first.split('attackBase').length - 1).toBe(1);
    // Unchanged: not resent, but the decoder keeps the last one.
    const tick = sim.state.tick;
    sim.state.tick += 100;
    const again = frame(2);
    expect(again).not.toContain('attackBase');
    expect(dec.decode(again).stats).toEqual(snap.stats);
    // A change goes out, but not again within the throttle.
    const saved = me.attackMul;
    me.attackMul *= 2;
    const changed = frame(3);
    expect(changed).toContain('attackBase');
    expect(dec.decode(changed).stats?.attack).toBeCloseTo(playerStats(sim.state, me).attack, 1);
    me.attackMul *= 2;
    sim.state.tick += 1;
    expect(frame(4)).not.toContain('attackBase');
    me.attackMul = saved;
    sim.state.tick = tick;
  });

  it('centre the interest area on the spectated player, keeping the viewer’s own state', () => {
    const local = lateGame(3, 5, { rifts: false });
    const s = local.state;
    const [p0, me] = [s.players[0]!, s.players[1]!];
    // The viewer is down far from the crowd around everyone else.
    me.x += 4000;
    me.y += 4000;
    me.dead = true;
    const enc = new SnapshotEncoder({ viewerId: 'p1' });
    const dec = new SnapshotDecoder(ids);
    let seq = 0;
    const step = () => {
      botStep(local);
      me.x = p0.x + 4000;
      me.y = p0.y + 4000;
      const bytes = enc.encode(s, local.drainEvents(), ++seq, 0) as Uint8Array;
      return { bytes: bytes.length, snap: dec.decode(bytes) };
    };
    const within = (snap: Snapshot, x: number, y: number) =>
      snap.enemies.every((n) => {
        const e = s.enemies.find((o) => o.id === n.id)!;
        return Math.hypot(e.x - x, e.y - y) <= INTEREST_RADIUS + 150;
      });
    const full = step();
    for (let i = 0; i < 10; i++) step();
    const alone = step();
    expect(within(alone.snap, me.x, me.y)).toBe(true);

    enc.focusId = 'p0';
    const switched = step();
    const near = s.enemies.filter((e) => Math.hypot(e.x - p0.x, e.y - p0.y) <= INTEREST_RADIUS);
    expect(near.length).toBeGreaterThan(20);
    expect(switched.snap.enemies.length).toBeGreaterThanOrEqual(near.length);
    expect(within(switched.snap, p0.x, p0.y)).toBe(true);
    // Every player is always sent (the viewer's own Pokémon included); `self` stays the viewer's.
    expect(switched.snap.players.map((p) => p.id)).toEqual(ids);
    expect(switched.snap.self?.cooldowns).toHaveLength(me.moves.length);
    // The switch costs about one full frame's worth of rows, once; the deltas after are normal.
    const after = [step(), step(), step()];
    expect(switched.bytes).toBeLessThan(full.bytes + 4000);
    for (const a of after) expect(a.bytes).toBeLessThan(switched.bytes / 2);
    // Back to the viewer: the crowd leaves (ids only), so that frame is small.
    enc.focusId = null;
    const back = step();
    expect(within(back.snap, me.x, me.y)).toBe(true);
    expect(back.bytes).toBeLessThan(switched.bytes / 2);
    // A focus that isn't a player falls back to the viewer.
    enc.focusId = 'nobody';
    expect(within(step().snap, me.x, me.y)).toBe(true);
  });

  it('start over with a full snapshot after a reset (reconnect)', () => {
    const enc = new SnapshotEncoder({ viewerId: 'p0' });
    enc.encode(sim.state, [], 1, 0);
    const second = enc.encode(sim.state, [], 2, 0) as Uint8Array;
    enc.reset();
    const fresh = new SnapshotDecoder(ids).decode(enc.encode(sim.state, [], 3, 0));
    expect(fresh.full).toBe(true);
    expect(fresh.enemies.length).toBeGreaterThan(0);
    expect(second.length).toBeLessThan(200);
  });
});

describe('events', () => {
  const viewer = { viewerId: 'me', x: 0, y: 0, radius: 1000, visible: (id: number) => id === 7 };
  it('keep what concerns the viewer and drop the rest', () => {
    const keep: SimEvent[] = [
      { type: 'say', key: 'hud.leftTheGame', seconds: 3 },
      { type: 'say', key: 'hud.leftTheGame', seconds: 3, playerId: 'me' },
      { type: 'player-hurt', playerId: 'other', amount: 3, label: null },
      // A teammate going down or coming back, however far away (the client's teammate alerts).
      { type: 'player-down', playerId: 'other' },
      { type: 'player-revived', playerId: 'other', by: null },
      { type: 'pickup', playerId: 'other', kind: 'coin', x: 10, y: 10, value: 1 },
      { type: 'enemy-action', id: 7, action: 'shoot' },
      { type: 'level-up', level: 3 },
    ];
    const drop: SimEvent[] = [
      { type: 'say', key: 'hud.leftTheGame', seconds: 3, playerId: 'other' },
      { type: 'pickup', playerId: 'other', kind: 'coin', x: 5000, y: 0, value: 1 },
      { type: 'enemy-action', id: 8, action: 'shoot' },
    ];
    expect(keep.filter((e) => isRelevant(e, viewer))).toEqual(keep);
    expect(drop.filter((e) => isRelevant(e, viewer))).toEqual([]);
  });

  it('round-trip through the shape codec, including unknown event types', () => {
    const strings = new Map<string, number>();
    const enc = new EventEncoder(
      (s) => strings.get(s) ?? (strings.set(s, strings.size + 1), strings.size),
    );
    const dec = new EventDecoder();
    const events = [
      {
        type: 'enemy-hurt',
        id: 3,
        x: 1.26,
        y: -2,
        amount: 12,
        label: null,
        shielded: false,
        byPlayer: 'me',
      },
      {
        type: 'enemy-hurt',
        id: 4,
        x: 3,
        y: 4,
        amount: 7.5,
        label: 'crit',
        shielded: true,
        byPlayer: null,
      },
      { type: 'future-event', chain: [{ x: 1.04, y: 2 }], nested: { a: 1 } },
    ] as unknown as SimEvent[];
    const w = new BinaryWriter();
    const shapes = enc.write(w, events);
    dec.addShapes(shapes);
    const back = new Map([...strings].map(([s, i]) => [i, s]));
    const out = dec.read(new BinaryReader(w.finish()), (i) => back.get(i) ?? null);
    expect(out).toEqual([
      { ...events[0], x: 1.3 },
      events[1],
      { type: 'future-event', chain: [{ x: 1, y: 2 }], nested: { a: 1 } },
    ]);
    // The second time, no new shapes are sent.
    expect(enc.write(new BinaryWriter(), events)).toBeUndefined();
  });

  it.each(['binary', 'json'] as const)(
    'carries recipient healing through %s snapshots without a table change',
    (format) => {
      const local = lateGame(0.1, 11);
      const me = local.state.players[0]!;
      const event: SimEvent = {
        type: 'enemy-healed',
        id: 1234,
        x: Math.round(me.x) + 20,
        y: Math.round(me.y),
        amount: 31.26,
      };
      const enc = new SnapshotEncoder({ viewerId: me.id, format });
      const dec = new SnapshotDecoder(local.state.players.map((p) => p.id));
      expect(dec.decode(enc.encode(local.state, [event], 1, 0)).events).toContainEqual({
        ...event,
        amount: 31.3,
      });
      expect(
        dec.decode(enc.encode(local.state, [{ ...event, amount: 7 }], 2, 0)).events,
      ).toContainEqual({ ...event, amount: 7 });
      expect(
        isRelevant(
          { ...event, x: me.x + 2000 },
          { viewerId: me.id, x: me.x, y: me.y, radius: 950, visible: () => true },
        ),
      ).toBe(false);
    },
  );
});

describe('snapshot buffer', () => {
  const snap = (tick: number, x: number): Snapshot =>
    ({
      tick,
      full: tick === 0,
      players: [{ id: 'a', index: 0, x, y: 0, aim: 0, moveAngle: 0 }],
      enemies: [],
      projectiles: [],
    }) as unknown as Snapshot;

  it('renders ~100 ms behind, between the snapshots around that time', () => {
    const buffer = new SnapshotBuffer({ delayMs: 100 });
    // A snapshot every 2 ticks (66.7 ms), arriving on time.
    for (let i = 0; i <= 10; i++) buffer.push(snap(i * 2, i * 10), 1000 + (i * 2 * 1000) / 30);
    const now = 1000 + (20 * 1000) / 30;
    const sample = buffer.sample(now)!;
    expect(sample.tick).toBeCloseTo(17, 5);
    const view = interpolate(sample);
    expect(view.players[0]!.x).toBeCloseTo(85, 5);
  });

  it('clamps to the newest snapshot when data stops coming', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(0, 0), 0);
    buffer.push(snap(2, 10), 66);
    expect(interpolate(buffer.sample(5000)!).players[0]!.x).toBe(10);
  });
});

describe('fields', () => {
  /** A field as the sim's `meteors()` / `mines()` leave it. */
  const field = (
    id: number,
    kind: 'meteor' | 'mine',
    ownerId: string,
    t: number,
    arm: number,
    life: number,
  ): FieldState => ({
    id,
    kind,
    ownerId,
    moveId: kind === 'meteor' ? 'rock-slide' : 'spikes',
    type: kind === 'meteor' ? 'rock' : 'ground',
    x: 300,
    y: 300,
    t,
    life,
    r: 46,
    damage: 10,
    arm,
    shotT: 0,
    range: 0,
    rate: 0,
    speed: 0,
    size: 0,
    pierce: 0,
    gone: false,
    burn: 0,
    poison: 0,
    slow: 0,
    knockback: 0,
  });

  it('carry what the client needs to draw a meteor falling and a mine arming', () => {
    const sim = createSim({ seed: 3, players: [{ id: 'me', dex: 25 }], debug: { noSpawns: true } });
    // A volley of two (the second staggered, as the sim does) and a mine.
    sim.state.fields.push(
      field(9001, 'meteor', 'me', 0, 0.5, 0),
      field(9002, 'meteor', 'me', -0.09, 0.5, 0),
      field(9003, 'mine', 'me', 0, 0.35, 7),
    );
    const enc = new SnapshotEncoder({ viewerId: 'me' });
    const dec = new SnapshotDecoder(['me']);
    const seen: { tick: number; fields: NetField[]; events: SimEvent[] }[] = [];
    for (let i = 0; i < 20; i++) {
      sim.step();
      const s = dec.decode(enc.encode(sim.state, sim.drainEvents(), i + 1, 0));
      seen.push({ tick: s.tick, fields: s.fields, events: s.events });
    }
    const meteor = seen
      .map((s) => s.fields.find((f) => f.id === 9001))
      .filter(Boolean) as NetField[];
    // It falls: progress climbs from 0 towards 1 and the time left to land counts down.
    expect(meteor.length).toBeGreaterThan(10);
    for (let i = 1; i < meteor.length; i++) {
      expect(meteor[i]!.progress).toBeGreaterThan(meteor[i - 1]!.progress);
      expect(meteor[i]!.arm).toBeLessThanOrEqual(meteor[i - 1]!.arm);
    }
    expect(meteor[0]!.progress).toBeLessThan(0.1);
    expect(meteor.at(-1)!.progress).toBeGreaterThan(0.85);
    // The staggered one waits (below 0) before it falls.
    expect(seen[0]!.fields.find((f) => f.id === 9002)!.progress).toBeLessThan(
      seen[0]!.fields.find((f) => f.id === 9001)!.progress,
    );
    // It lands: gone from the snapshot, with a blast event the client draws.
    const landed = seen.findIndex((s) => !s.fields.some((f) => f.id === 9001));
    expect(landed).toBeGreaterThan(0);
    expect(seen[landed]!.events.some((e) => e.type === 'field-blast' && e.id === 9001)).toBe(true);
    // The mine arms after its delay (arm reaches 0) while its life goes on.
    const mine = seen.map((s) => s.fields.find((f) => f.id === 9003)!);
    expect(mine[0]!.arm).toBeGreaterThan(0.2);
    expect(mine.at(-1)!.arm).toBe(0);
    expect(mine.at(-1)!.progress).toBeGreaterThan(mine[0]!.progress);
  });
});

describe('interpolation across jumps', () => {
  it('never slides an entity the sim relocated (stragglers sent ahead, arena trips)', () => {
    // This seed relocates three stragglers within 30 simulated seconds. Keep the
    // codec/buffer regression short rather than simulating two full late-game runs.
    const opts = { players: 1, seconds: 30, seed: 3 };
    const before = measureJumps({ ...opts, snap: false });
    expect(before.simTeleports).toBeGreaterThan(0);
    expect(before.jumps.filter((j) => j.kind === 'enemy').length).toBeGreaterThan(0);
    const after = measureJumps(opts);
    expect(after.jumps).toEqual([]);
  });

  it('snaps samples further apart than anything moves, and lerps the rest', () => {
    const a = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 0, y: 0 },
    ];
    const b = [
      { id: 1, x: 30, y: 0 },
      { id: 2, x: 900, y: 0 },
      { id: 3, x: 5, y: 5 },
    ];
    const out = interpolateList(a, b, 0.5, [], maxStep(2));
    expect(out.map((e) => [e.id, e.x])).toEqual([
      [1, 15],
      [2, 900],
      [3, 5],
    ]);
    expect(maxStep(1)).toBeCloseTo(60);
  });
});
