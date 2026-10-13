import { z } from 'zod';
import { DexSchema, IdSchema, TextSchema } from './common.js';

export const TraitSchema = z.strictObject({
  id: IdSchema,
  name: TextSchema,
  description: TextSchema,
});

export const StarterSchema = z.strictObject({
  dex: DexSchema,
  startingMove: IdSchema,
  /** `[primary, secondary]`; the primary trait's score counts double when matching. */
  traits: z.tuple([IdSchema, IdSchema]),
});
export type Starter = z.infer<typeof StarterSchema>;

export const PersonalityQuestionSchema = z.strictObject({
  question: TextSchema,
  answers: z
    .array(
      z.strictObject({
        text: TextSchema,
        /** Trait id → points. */
        points: z.record(IdSchema, z.number().int().positive()),
      }),
    )
    .min(2),
});
export type PersonalityQuestion = z.infer<typeof PersonalityQuestionSchema>;

export const StartersFileSchema = z.strictObject({
  traits: z.array(TraitSchema),
  starters: z.array(StarterSchema).min(1),
  personalityTest: z.array(PersonalityQuestionSchema).min(1),
});
export type StartersFile = z.infer<typeof StartersFileSchema>;
