# Manual gacha collection projections

Run from the repository root after `pnpm install`:

```sh
pnpm --filter @pokesurvivor/tools exec tsx gacha/collection.js --help
pnpm --filter @pokesurvivor/tools exec tsx gacha/collection.js \
  --trials 1000 --mode pulls --out /absolute/path/pulls.json
pnpm --filter @pokesurvivor/tools exec tsx gacha/collection.js \
  --trials 300 --mode play --out /absolute/path/play.json
```

This is an offline tuning tool, outside CI. It never changes game data, connects to a database,
spends real tickets, or asserts balance targets. Output paths are relative to the tools package
when using the commands above. Large play projections can take several minutes. Progress goes
to stderr; JSON goes to stdout unless `--out` is supplied.

The defaults compare Kanto and Paldea under the live configuration, a base-rate-only diagnostic,
and three **hypothetical** options. `--options no-pity` disables pity for an attribution
comparison while retaining the selected pull style and the live base rates. The option numbers live together in `definitions` in the
script. Excess legendary weight is moved to Common so weights still total 100. Option C also
models a proposed unowned-first rule for normal Common–Epic results; that rule is not live.
Change `--regions` and `--options` to run smaller comparisons or all nine regions. `--seed` makes
a run reproducible. The same seed identifies comparable histories across options.

## What is exact

- Banner pools and sprite availability come from the current server data. “Legendary” in the
  output means rarity 5, including Pokémon such as Dragonite that lack the `legendary` flag.
- Gacha uses the production `rollPulls` engine: per-banner soft/hard pity, the tenth-slot
  Epic-or-better roll, rarity fallback, uniform normal selection, shiny availability and shiny
  duplicate redirection, and coin refunds. All pulls target one banner. Normal and shiny both
  count toward the species collection; completing every shiny is a different problem.
- In pull mode there are no starter or gameplay grants. `multi` means all pulls are in batches
  of ten; `single` means individual pulls. Counts are individual pulls, not paid ×10 tickets.
- Play mode starts with one regional starter (or Bulbasaur if no starter exists), runs the real
  achievement and mission reward functions against an in-memory save, and applies the real solo
  reward caps. All earned ×10 tickets buy multis; single tickets are saved for multis by default.
  `--pull-style single` spends single tickets immediately but still uses ×10 tickets as multis.
- Rift species come from the global legendary-flag pool, weighted toward unbeaten species by
  the configured weight. Beaten history stays fixed within a run, as in the sim. Ordinary rift
  wins grant **no Pokémon**; defeating a shiny rift legend grants its shiny and normal species.
  The model includes their normal/×10 tickets and individual-legend achievements.
- Wild shiny catches, including shiny bosses, and successful rescue joins grant species globally.
  Rescues use the production eligibility function. Rewards are banked at run end. Starters,
  achievements and missions do not grant additional Pokémon.

## What is a play assumption

This is a macro economy model, not a combat or movement replay, and the defaults are illustrative
rather than measured player telemetry. The code reads live scheduling and reward probabilities;
combat, exploration and mission inputs below are assumptions. A one-second scheduler handles
rift downtime, escalating rift checks, expiration, arena duration, delayed bosses and event/thief
map clocks. It rolls the real run roster for ordinary wild shinies and bosses. Event-specific
horde casts, geometry/placement failures, minion composition and player movement are approximated.
Rescue rewards are booked within their event; incomplete rescues near run end may be overcounted.
Coins used for missions are an estimate, not a complete simulation of coin earnings/spending.

Override any default with `--profile /absolute/path/profile.json`, for example:

```json
{
  "runMinutes": 20,
  "downtimeMinutes": 2,
  "hoursPerDay": 2,
  "riftWinChance": 0.85
}
```

| Field                 | Default | Meaning                                                        |
| --------------------- | ------- | -------------------------------------------------------------- |
| `runMinutes`          | 15      | Fixed duration survived, in game minutes                       |
| `downtimeMinutes`     | 2       | Menus and gacha between runs                                   |
| `hoursPerDay`         | 1       | Session hours per calendar day for daily/weekly mission resets |
| `killsPerMapMinute`   | 70      | Ordinary kills outside arenas; ×0.25 during boss fights        |
| `riftEnterChance`     | 0.8     | Fraction of opened rifts entered                               |
| `riftWinChance`       | 0.65    | Win probability per entered rift                               |
| `riftApproachSeconds` | 10      | Time to reach an entered rift                                  |
| `riftWinSeconds`      | 45      | Winning fight duration; loss uses the live arena time limit    |
| `bossKillChance`      | 0.8     | Probability of defeating each due map boss                     |
| `bossSeconds`         | 25      | Map-boss suppression of ordinary kills and other events        |
| `pickupChance`        | 0.9     | Collection fraction for loose map tickets; rift loot pulled in |
| `thiefKillChance`     | 0.7     | Success against a treasure thief                               |
| `rescueSuccess`       | 0.6     | Fraction of lost Pokémon brought home                          |
| `rescueSeconds`       | 60      | Lost event duration                                            |
| `chestsPerMapHour`    | 2       | Locked chests opened per hour outside rift downtime            |
| `level`               | 30      | Level reached, for achievements and missions                   |
| `evolutionsPerRun`    | 1       | Move evolutions; eligible move ids sampled uniformly           |
| `coop`                | false   | Group-run achievement flag and bypass solo caps                |
| `nonGacha`            | true    | Include gameplay species catches/rescues; false is an ablation |

Mission templates, goal draws, counters, resets and claims use server code. The player claims
all completed missions automatically, does not reroll or change partners for typed missions,
and kills of each type are estimated at one ninth of ordinary kills. The `coop` switch is not
a complete team model: rift unbeaten weighting still represents one player's history; adjust
kill and win rates explicitly for a different team. Ordinary rock/chest XP drops can also roll
rare single tickets; these incidental tickets are omitted. They cannot directly grant Pokémon.

## Reading output

Each tier has mean completion pulls (plus hours in play mode), standard error of that mean,
10th/50th/90th percentiles, and the number of histories censored at the configured horizon.
If any history is censored, the reported mean is `null`; increase `--max-pulls` or `--max-hours`.
Percentiles then describe completed histories only. Empty tiers complete immediately.

`fractionAtPulls` / `fractionAtHours` are mean species fractions owned, not the probability of
completing the tier. Play pull snapshots include gameplay grants earned before that draw.
`legendaryLast` is the fraction of histories where rarity 5 completed at or after every other
tier; censored histories do not count as successes. `pullsPerLegendary` counts gacha results
only, including duplicates. `refundAtPulls` includes only gacha duplicate coins.

`pullsAtHours` uses only rewards banked by the requested hour. `sourcesPerHour` breaks down
pull equivalents earned (a ×10 ticket is ten), including achievements/missions and any negative
solo cap adjustment. `metricsPerHour` exposes the resulting run/rift cadence. These rates are
averages over each history's simulated duration; time includes menu downtime. Source rates are
not separately tabulated by one-time versus recurring achievement rewards.

Gameplay randomness is independent of gacha randomness and reused across options for the same
trial. Completed species counts and completion times are tracked per individual pull, even
inside a batch of ten. Use a second seed, more trials and alternative profiles to distinguish
Monte Carlo noise from model uncertainty. Do not turn these projections into CI balance tests.
