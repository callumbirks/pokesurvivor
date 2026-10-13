import { z } from 'zod';
import { IdSchema } from './common.js';

/**
 * A synthesized track (played by the client's synth).
 * melody: bars like "A4:4 C5:2 -:2" (note:length in 16ths, 16 per bar, "-" = rest).
 * parts: generated from `chords` with a 16-character pattern per bar:
 *   R root (chord bass with useBass) · F fifth · O octave · T third · 0-5 chord notes ·
 *   C whole chord · "-" holds the previous note · "." rest.
 * drums: X loud · x medium · o soft · . nothing.
 */
export const TrackSchema = z.strictObject({
  bpm: z.number().positive(),
  swing: z.number().min(0).max(1).optional(),
  chords: z.array(z.string().min(1)).min(1),
  melody: z.array(
    z.strictObject({
      instrument: IdSchema,
      velocity: z.number().positive(),
      bars: z.array(z.string()).min(1),
    }),
  ),
  parts: z.array(
    z.strictObject({
      instrument: IdSchema,
      octave: z.number().int(),
      velocity: z.number().positive(),
      pattern: z.string().length(16),
      useBass: z.boolean().optional(),
    }),
  ),
  drums: z.record(z.string(), z.string().length(16)),
});
export type Track = z.infer<typeof TrackSchema>;

export const MusicFileSchema = z.record(IdSchema, TrackSchema);
export type MusicFile = z.infer<typeof MusicFileSchema>;
