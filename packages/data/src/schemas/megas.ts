import { z } from 'zod';
import { DexSchema, IdSchema, TextSchema } from './common.js';

/**
 * How a Pokémon changes form in a run (the wording on its card and banner): it Mega Evolves, it
 * undergoes Primal Reversion (Kyogre, Groudon), or it takes up its Rusted Sword / Shield (Zacian,
 * Zamazenta). It's also the form's sprite key: `assets/pokemon/{dex}-{kind}/`.
 */
export const MegaKindSchema = z.enum(['mega', 'primal', 'crowned']);
export type MegaKind = z.infer<typeof MegaKindSchema>;

/** A partner that can Mega Evolve during a run (the "Unique" level-up card, `tuning.mega`). */
export const MegaFormSchema = z.strictObject({
  dex: DexSchema,
  kind: MegaKindSchema,
  /** The form's SpriteCollab folder, `sprite/{dex4}/{spriteCollab}` (tools/sprites/import-forms.ts). */
  spriteCollab: z.string().regex(/^\d{4}$/),
  /** The item it uses: its icon is `apps/client/public/items/{item}.png` (16×16). */
  item: IdSchema,
  itemName: TextSchema,
  /** The form's name: "Mega Charizard X", "Primal Kyogre", "Crowned Sword Zacian". */
  name: TextSchema,
});
export type MegaForm = z.infer<typeof MegaFormSchema>;

export const MegasFileSchema = z
  .strictObject({ forms: z.array(MegaFormSchema).min(1) })
  .refine((f) => new Set(f.forms.map((m) => m.dex)).size === f.forms.length, {
    message: 'One form per Pokémon',
  });
export type MegasFile = z.infer<typeof MegasFileSchema>;

/** The sprite key of a form: `{dex}-{kind}` (`6-mega`), the directory under `assets/pokemon/`. */
export const formKey = (dex: number, kind: string): string => `${dex}-${kind}`;
