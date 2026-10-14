# Enemy support balance: shields and healing (2026-10-14)

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

## Enemy healing

This follow-up targets 1.3–1.6× kill time for regular enemies with one or several healers, while
mixed healer/shielder packs must remain killable. It is based on main after PRs #24–#26
(`c945dcf8eb906af1e44557df93c958138dbf5d35`, protocol v6). The removed original is available through
`git show a14661bf:legacy/js/entities/enemy.js`; its `healAround` and skill cadence match the port.
No stronger-than-original healing rule was found. The original also had green bursts on each
recipient, which the port previously omitted.

### Healing sources and rules

There is one enemy healing source, `healAround`, used by the `healer` behaviour. Fixed healers:
Clefairy, Clefable, Chansey, Cleffa, Marill, Azumarill, Blissey, Delcatty, Happiny, Audino,
Alomomola, Sylveon, Comfey and Hatterene (dex 35, 36, 113, 173, 183, 184, 242, 301, 440, 531,
594, 700, 764, 858). Their run roster is rolled by tier, like shielders. Boss AI does not cast
heals, but nearby support healers previously healed bosses and rift legendaries.

The old amount is `maxHp × 0.07 × min(2.5, max(1, strongestPlayerAttackRatio)^0.35)`, where the
ratio includes attack upgrades/cards and attack buffs. Thus each cast restores 7–17.5% of max HP;
the representative attack ratios 1.4/2/3 produce 7.87%/8.92%/10.28%. Time, tier, co-op, elite and
shiny scaling increase max HP and therefore the absolute heal; there is no separate time/level
multiplier. Every wounded, living enemy whose body touches the 150-unit query circle is healed,
including the caster. There is no target limit, recipient cooldown or restriction on shielded
targets. Several healers can restore HP separately; all healing clamps to max HP.

The initial cast delay is random 0.3–3.5 seconds; subsequent casts are every 3.5 seconds **while
a player is within the healer's activation range** (230 + 6 × tier index). The timer continues
outside that range, so a ready healer casts on entering it. The ally healing radius and player
activation range are distinct. There is no other enemy regeneration, self-heal, lifesteal or
healing from weather, hazards, moves or springs. Springs/pickups/regen affect players only.
Shiny max-HP initialization at creation is not periodic healing.

New parameters live next to shields in `tuning.json.enemyHeals`:

| Rule                    | Old                                                | New                                                                                     |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Amount                  | 7–17.5% max HP per cast; scales with player attack | Consume earned healing credit, at most 10% max HP per cast                              |
| Credit                  | No limit on cumulative restored HP                 | Actual HP damage earns 30% of that damage as credit; stored credit capped at 10% max HP |
| Caster cooldown         | 3.5 s                                              | 3.75 s (`cooldown`)                                                                     |
| Initial caster delay    | 0.3–3.5 s                                          | 0.3–3.75 s (`initialCooldown`)                                                          |
| Recipient cooldown      | None                                               | 3.75 s after successful healing, shared by all healers (`recipientCooldown`)            |
| Targets                 | All wounded living enemies                         | Nearest 3 eligible targets, including self (`maxTargets`)                               |
| Ally radius             | 150 + body radius                                  | Same (`radius`)                                                                         |
| Player activation range | 230 + 6 × tier                                     | Same                                                                                    |
| Max HP / resurrection   | No overheal or resurrection                        | Same                                                                                    |
| Bosses / legendaries    | Healable                                           | Excluded (`affectsBosses: false`)                                                       |
| Shielded targets        | Healable                                           | Wait for the shield to break/expire (`affectsShielded: false`)                          |

Every heal consumes credit once. A later heal needs new HP damage, and another caster shares
the same credit and cooldown. Shield absorption earns **zero** credit; partial shield overflow
earns credit for the actual HP loss only. Credit counts damage from attacks and damage-over-time
effects; healing itself never generates credit. Increasing attack no longer independently buffs
enemy heal amounts. Old solo saves and arena stashes start at zero credit/cooldown; current saves
restore the fields exactly.

This bounds total healing to 30% of HP damage. Without shields, ignoring unused credit, the
sustained extra-health factor cannot exceed `1 / (1 - 0.3) ≈ 1.43`. The 10% cap and cooldown also
limit burst healing and coverage. Shielded packs retain exposed intervals and cannot fund healing
with absorbed shield damage; killing either support removes its future benefit.

### Before/after healing measurement

Run `pnpm --filter @pokesurvivor/sim heals`. It extends the shield fixture with the **same**
median-tier targets, spawn scaling, neutral DPS and half-second hits. The player's actual attack
multiplier now matches the DPS build, so the original heal attack scaling is measured correctly.
Targets stand 140 units from the player, and immortal supports are placed 80 units around them;
this engages both the player activation range and ally radius. Shield-only results remain the
same as above. Healers first become ready at 0/1.1/2.2 seconds; shielders at 0/2/4 seconds.
These remain controlled balance fixtures, not playtest telemetry, and cast/burst timing can vary.

| Minute | HP     | DPS | No supports | Old: 1 healer | New: 1 healer | Old: 3 healers | New: 3 healers | New ratios (1 / 3) |
| ------ | ------ | --- | ----------- | ------------- | ------------- | -------------- | -------------- | ------------------ |
| 3      | 626    | 62  | 10.03 s     | 12.03 s       | 13.03 s       | 28.03 s        | 13.53 s        | 1.30× / 1.35×      |
| 8      | 5,599  | 180 | 31.03 s     | 133.53 s      | 43.53 s       | >180 s         | 42.53 s        | 1.40× / 1.37×      |
| 15     | 17,020 | 510 | 33.03 s     | >180 s        | 47.03 s       | >180 s         | 46.03 s        | 1.42× / 1.39×      |

At minute 3, one healer is slightly stronger (+1 second TTK) to hit the requested support feel;
three healers are much weaker. The nominal new 10% cap can exceed an early old heal, but the
damage budget, target cap, longer cooldown and shared recipient cooldown remove the late-game
and multi-healer growth. A flat max-HP percentage alone would retain that problem. Several
casters cannot create more credit; differences of about a second reflect when the final heal
lands relative to the half-second damage bursts.

Healing added 187.8 / 2,241 / 6,961.5 HP with one healer, versus 147.9 / 18,482.9 / at least
87,502.4 HP before. For the 180-second censored trials, “>180 s” means the target was still alive;
it does not claim that every one-healer trial is mathematically immortal.

The **combined** baseline already includes the nerfed shields from PR #24:

| Minute | Old: 1 healer + 1 shielder | New: 1 + 1 | Old: 3 healers + 3 shielders | New: 3 + 3 | New ratios (1 + 1 / 3 + 3) |
| ------ | -------------------------- | ---------- | ---------------------------- | ---------- | -------------------------- |
| 3      | 20.03 s                    | 18.03 s    | 109.03 s                     | 19.03 s    | 1.80× / 1.90×              |
| 8      | >180 s                     | 64.03 s    | >180 s                       | 61.03 s    | 2.06× / 1.97×              |
| 15     | >180 s                     | 67.53 s    | >180 s                       | 68.03 s    | 2.04× / 2.06×              |

Mixed packs add more toughness than either support alone, but die within 18–68 seconds in these
fixtures. Regression tests cover the 1.3–1.6× isolated-healer goal (one sim tick of tolerance) and
keep mixed packs below 2.1×. There is no unlimited replacement of lost HP.

### Healing readability and protocol

The caster keeps its heart icon, charge animation, green radius ring and heal sound. Each
successful recipient now gets a green pulse, particles and a green `+HP` number (the pulse
remains when damage numbers are disabled). This uses a new cosmetic `enemy-healed` event through
the existing shape codec, with position and actual restored amount. HP already travels in the
snapshot. No table/message change is needed, so this follow-up keeps main's **protocol v6**;
older clients ignore the cosmetic event and still receive the healed HP.
