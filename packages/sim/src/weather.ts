// Weather modifiers. Phase 2b adds the weather system (legacy systems/weather.js); combat and
// movement already go through these, so it only has to fill them in.
import type { Ctx } from './ctx.js';
import type { PokemonType } from '@pokesurvivor/data';

/** Damage multiplier for attacks of `type` under the current weather. */
export function weatherDamageMult(_ctx: Ctx, _type: PokemonType | null): number {
  return 1;
}

/** Speed multiplier for a Pokémon of these types under the current weather. */
export function weatherSpeedMult(_ctx: Ctx, _types: readonly PokemonType[]): number {
  return 1;
}
