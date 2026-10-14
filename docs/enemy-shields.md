# Enemy shield balance (2026-10-14)

The target is 1.3–1.6× time to kill for a shielded regular enemy. One fully consumed shield adds
30% HP; repeated shields remain useful, but have a long exposed interval. Shielders retain their
support icon and self-shield, so killing them removes protection from the pack.

## Audit and tuning

There is one source: `castShields` in `packages/sim/src/enemies.ts`, called by the `shielder`
behaviour. The fixed roster is Onix, Mr. Mime, Steelix, Shuckle, Skarmory, Aggron, Metang, Shieldon,
Bastiodon, Bronzor, Bronzong, Mime Jr., Probopass and Carbink (dex 95, 122, 208, 213, 227, 306,
375, 410, 411, 436, 437, 439, 476, 703). These appear according to the run's rolled tier roster;
bosses use separate AI. There are no move, hazard or boss-skill shield sources.

The old port matches the original game (`castShields`, `shieldT`, `skillCd`, `hurt`),
including the spatial query's body-radius overlap. No stronger-than-legacy shield rule was found.
This intentionally changes balance in the deterministic sim. The original implementation is preserved in Git history.

| Rule                             | Old port / legacy                              | New (`tuning.json.enemyShields`)                                 |
| -------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| HP per application               | 35% of recipient max HP                        | Cap of 30% (`maxHpFraction`)                                     |
| Duration                         | 8 s                                            | 3.5 s (`duration`)                                               |
| Caster cooldown                  | 6 s                                            | 12 s (`cooldown`)                                                |
| Initial caster cooldown          | Random 1–4 s                                   | Same, now data (`initialCooldown`)                               |
| Recipient reapplication cooldown | None                                           | 12 s from application (`reapplyCooldown`), shared by all casters |
| Recast while shielded            | Refill to at least 35% HP and restart duration | Ignore; neither HP nor duration refreshes                        |
| Coverage                         | Nearest 6 alive enemies, including self        | Nearest 3 eligible enemies, including self (`maxTargets`)        |
| Range                            | 160 + recipient body radius                    | Same (`radius`)                                                  |
| Bosses / rift legendaries        | Eligible                                       | Excluded (`affectsBosses: false`)                                |

The shield scales with **max** HP, never current HP. Thus time, tier, co-op HP, elite and shiny
scaling all increase its absolute size; there is no independent level/time multiplier. At the
measured minutes a regular spawn's time multiplier is `(1 + seconds / 95)`, multiplied by the
density toughness factor `3.3 + min(1.7, seconds / 210)`. Shields absorb the already-calculated
damage first; crits and super-effective hits already break them faster through normal damage.

Old shields do not add arithmetically, but refilling them repeatedly is effectively unlimited
extra HP. With one caster, the replenishment budget is 35% max HP every six seconds. Multiple
staggered casters can keep topping up a target before any hit reaches HP. The new recipient cooldown
and refusal to extend live shields close both routes. Duration now ticks before behaviour early
returns, fixing the inherited case where a shielded thief never expired its shield. Old solo saves
and arena stashes migrate to the new cap, duration and recipient cooldown; current saves retain
their exact state when restored.

## Headless measurement

Run `pnpm --filter @pokesurvivor/sim shields`. The same fixture was run against the original
`enemies.ts` at base commit `a14661bf382afb362f3ee2e60d2a69b3f37b4eef` and the new implementation.
It runs the real enemy AI, expiry, recast and absorption at 30 Hz, using a median ordinary enemy
from the latest unlocked tier and real `spawnOne` HP scaling. It applies neutral single-target
damage in half-second hits, with immortal, stationary shielders 80 units around the recipient.
The encounter starts with a cast ready; with three shielders the initial casts are staggered
at 0, 2 and 4 seconds. There are no healers, other attacks, movement, terrain damage or aim losses.

These are representative balance builds, **not playtest telemetry**: Pikachu's base attack ×1.4,
×2 and ×3; Tackle level 3, level 5 and evolved level 5 at minutes 3, 8 and 15. Move damage and
cooldown come from actual data, with neutral DPS 62, 180 and 510 respectively. Enemy HP is 626
(Volbeat), 5,599 (Primarina) and 17,020 (Empoleon). Other builds and burst timing can differ.

| Minute | DPS | No shield TTK | Old, 1 caster   | New, 1 caster | New ratio | Old shield share of EHP | New shield share of EHP |
| ------ | --- | ------------- | --------------- | ------------- | --------- | ----------------------- | ----------------------- |
| 3      | 62  | 10.03 s       | 24.03 s (2.40×) | 16.03 s       | 1.60×     | 58.3%                   | 37.5%                   |
| 8      | 180 | 31.03 s       | >180 s          | 45.53 s       | 1.47×     | ≥85.3%                  | 31.8%                   |
| 15     | 510 | 33.03 s       | >180 s          | 47.53 s       | 1.44×     | ≥84.4%                  | 30.3%                   |

With **three** casters, the old target survives all three 180-second runs with **zero HP damage**;
shield EHP shares are at least 94.7%, 85.3%, 84.4%. The new results match one caster: 16.03,
45.53 and 47.53 seconds. Overlap no longer raises protection on one recipient.

EHP here is target max HP + cumulative shield HP actually absorbed, excluding shields that expire
unused. Shield share is absorbed / EHP. For kills this is the complete encounter; for old runs
stopped at 180 seconds it is a lower bound, since shielding can continue. In those censored runs
100% of incoming damage was absorbed by shields, with no finite kill time observed. The regular
sim regression checks that the new one- and three-caster results stay between 1.3× and 1.6×.

## Readability and protocol

The existing bubble, blue shield-hit numbers and support icon remain. Shielded enemies now show
their HP bar even at full HP, plus a blue remaining-shield bar above it on the same max-HP scale.
The support icon moves up to clear both bars. Full and delta snapshots send remaining shield HP,
rounded up, in a new enemy-table column. This changes table width and requires **protocol v5**;
deploy client and server together. See [protocol.md](protocol.md).
