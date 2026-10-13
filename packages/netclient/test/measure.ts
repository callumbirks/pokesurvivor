import { deflateRawSync } from 'node:zlib';
import type { Sim, SimEvent } from '@pokesurvivor/sim';
import { SnapshotDecoder, SnapshotEncoder, type SnapshotFormat } from '../src/snapshot.js';
import { botStep } from './late-game.js';

export interface Measurement {
  format: SnapshotFormat;
  radius: number;
  hz: number;
  /** Mean bytes per second per client. */
  bytesPerSecond: number;
  /** The same frames deflated one by one (permessage-deflate without context takeover). */
  deflatedPerSecond: number;
  maxFrame: number;
  /** Mean bytes per second of the JSON part (choices, events, details). */
  jsonPerSecond: number;
  fullFrame: number;
}

/** Streams snapshots for every player for `seconds` of play and decodes them as a check. */
export function measure(
  sim: Sim,
  opts: { seconds: number; hz: number; format: SnapshotFormat; radius?: number },
): Measurement {
  const ids = sim.state.players.map((p) => p.id);
  const encoders = ids.map(
    (viewerId) => new SnapshotEncoder({ viewerId, format: opts.format, radius: opts.radius }),
  );
  const decoders = ids.map(() => new SnapshotDecoder(ids));
  let bytes = 0;
  let deflated = 0;
  let json = 0;
  let maxFrame = 0;
  let fullFrame = 0;
  let frames = 0;
  let events: SimEvent[] = [];
  const ticks = Math.round(opts.seconds * 30);
  let next = 0;
  let seq = 0;
  for (let t = 0; t < ticks; t++) {
    botStep(sim);
    events.push(...sim.drainEvents());
    if (t < next) continue;
    next += 30 / opts.hz;
    seq++;
    encoders.forEach((enc, i) => {
      const frame = enc.encode(sim.state, events, seq, 0);
      const size = typeof frame === 'string' ? Buffer.byteLength(frame) : frame.length;
      const snap = decoders[i]!.decode(frame);
      if (seq === 1) {
        fullFrame = Math.max(fullFrame, size);
        return;
      }
      bytes += size;
      json += Buffer.byteLength(
        JSON.stringify({ c: snap.choices, w: snap.waiting, e: snap.events }),
      );
      maxFrame = Math.max(maxFrame, size);
      frames++;
      deflated += deflateRawSync(typeof frame === 'string' ? Buffer.from(frame) : frame).length;
    });
    events = [];
  }
  const perClientSeconds = frames / ids.length / opts.hz;
  return {
    format: opts.format,
    radius: opts.radius ?? 950,
    hz: opts.hz,
    bytesPerSecond: bytes / ids.length / perClientSeconds,
    deflatedPerSecond: deflated / ids.length / perClientSeconds,
    jsonPerSecond: json / ids.length / perClientSeconds,
    maxFrame,
    fullFrame,
  };
}
