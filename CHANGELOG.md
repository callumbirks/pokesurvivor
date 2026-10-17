# Changelog

What changed for players in each release, newest first. Generated from
`packages/data/changelog.json` by `pnpm changelog`: edit the JSON, not this file. See
[CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add entries.

## Unreleased

PRs: [#102](https://github.com/callumbirks/pokesurvivor/pull/102)

### Fixed

- Co-op runs that carried over a server update are credited again.

## v17 - 2026-10-17

PRs: [#98](https://github.com/callumbirks/pokesurvivor/pull/98), [#99](https://github.com/callumbirks/pokesurvivor/pull/99), [#100](https://github.com/callumbirks/pokesurvivor/pull/100)

### New

- Repertoire now lets you choose your second starting move (or keep it random) on the Upgrades screen.
- Gems: a rare new currency found in runs.
- Spend 100 gems to reset a Pokémon's upgrades and get all its PokéCoins back.

### Changed

- Prestige now costs 100 gems.

### Fixed

- Group leaderboard entries show the level and Pokémon defeated once instead of once per player.

## v16 - 2026-10-16

PRs: [#92](https://github.com/callumbirks/pokesurvivor/pull/92), [#93](https://github.com/callumbirks/pokesurvivor/pull/93), [#94](https://github.com/callumbirks/pokesurvivor/pull/94), [#95](https://github.com/callumbirks/pokesurvivor/pull/95), [#96](https://github.com/callumbirks/pokesurvivor/pull/96)

### New

- Server updates no longer end co-op runs: you get a short warning, and your run continues right after the update.

### Changed

- Wild Pokémon get tougher faster after the first few minutes, and hit a little harder later on.
- Rare, Epic and Legendary upgrade cards are rarer, especially after minute 8.
- Momentum now tops out at ×1.2 and drains a little faster.
- Defence now works as toughness (+100% defence halves damage), up to +500%, instead of stopping at 70% damage reduction. Armor, Assault Vest, Harden and prestige give defence.

### Fixed

- After an update the game no longer gets stuck on a black or white screen until you hard-refresh.

### Behind the scenes

- Balance can now be tuned live by admins, without an update: new runs use the latest settings and runs already going keep theirs.
- Every run records which balance settings it was played with.
- Every run now keeps a balance record per player (cards picked, stats each minute, what knocked you out), and admins can export them to see what made runs easy or hard. It doesn't change rewards.

## v15 - 2026-10-15

PRs: [#85](https://github.com/callumbirks/pokesurvivor/pull/85), [#86](https://github.com/callumbirks/pokesurvivor/pull/86), [#87](https://github.com/callumbirks/pokesurvivor/pull/87), [#88](https://github.com/callumbirks/pokesurvivor/pull/88), [#89](https://github.com/callumbirks/pokesurvivor/pull/89), [#90](https://github.com/callumbirks/pokesurvivor/pull/90)

### New

- While you're down in co-op, you can spectate your teammates and switch between them.
- Prestige: once all of a Pokémon's upgrades are maxed, you can prestige it. This resets its upgrades and earns it a star (up to 3), and each star gives it +5% HP, damage, speed and crit chance, and −5% cooldown and damage taken. Stars show wherever the Pokémon appears.

### Changed

- Power cards now stop at ×20 damage.
- Synthesis cards now stop at +10 HP regenerated per second.
- Usernames with offensive words are no longer accepted.

### Fixed

- Keyboard and controller: you can now reach the Play button on the Pokémon select screen, and it starts with the Pokémon you picked, not the last one you moved over.
- On phones in portrait, the Pokémon picker grid is no longer squeezed by the filters.

## v14 - 2026-10-15

PRs: [#80](https://github.com/callumbirks/pokesurvivor/pull/80), [#81](https://github.com/callumbirks/pokesurvivor/pull/81), [#82](https://github.com/callumbirks/pokesurvivor/pull/82), [#83](https://github.com/callumbirks/pokesurvivor/pull/83)

### New

- When a teammate revives you, you now get a clear "You're back up!" banner naming who revived you, with a green glow and its own sound.
- Upgrade cards now come in Common, Rare, Epic and Legendary, with bigger bonuses, and better odds later in a run.
- See your stats and card bonuses in the top-left corner (toggle in Settings).

### Changed

- Wild Pokémon hit about 10% less hard.
- A few wild Pokémon now appear and catch up ahead of you again, so running isn't completely safe.
- Upgrade cards no longer have pick limits. Sprint, Reflexes, Magnet and Learning stop at a maximum instead, and Armor still stops at 70%.

## v13 - 2026-10-15

PRs: [#77](https://github.com/callumbirks/pokesurvivor/pull/77), [#78](https://github.com/callumbirks/pokesurvivor/pull/78)

### Changed

- Early wild Pokémon hit less hard again, and new arrivals now come mostly from behind and the sides, so you can gather a horde and turn to fight it.
- Momentum's limit now grows during a run: up to +20% at the start, reaching +60% by minute 10.

## v12 - 2026-10-15

PRs: [#73](https://github.com/callumbirks/pokesurvivor/pull/73), [#75](https://github.com/callumbirks/pokesurvivor/pull/75)

### New

- Momentum: chain defeats to build up to +60% damage, so turning to fight the horde pays off. It shows under your HP and drains a few seconds after your last defeat. From minute 15, every level-up also offers Power or Reflexes.

### Changed

- Rifts in 3–4 player co-op reach full strength sooner, and wild Pokémon hit twice as hard as in v11.

## v11 - 2026-10-15

PRs: [#69](https://github.com/callumbirks/pokesurvivor/pull/69), [#70](https://github.com/callumbirks/pokesurvivor/pull/70), [#71](https://github.com/callumbirks/pokesurvivor/pull/71)

### Fixed

- You're prompted to reload when a new version is released, instead of only after big updates.
- The first rift in 3–4 player co-op is beatable again: rift toughness now ramps up over the first few minutes.

## v10 - 2026-10-15

PRs: [#59](https://github.com/callumbirks/pokesurvivor/pull/59), [#61](https://github.com/callumbirks/pokesurvivor/pull/61), [#62](https://github.com/callumbirks/pokesurvivor/pull/62), [#63](https://github.com/callumbirks/pokesurvivor/pull/63), [#64](https://github.com/callumbirks/pokesurvivor/pull/64), [#65](https://github.com/callumbirks/pokesurvivor/pull/65), [#66](https://github.com/callumbirks/pokesurvivor/pull/66)

### New

- Show network stats (Settings → Graphics, or add ?netstats to the address): see your ping, packet timing, corrections and frame rate during co-op, to tell whether hiccups come from your connection, your browser or the server.

### Changed

- Legendaries are rarer in the gacha: base chance 0.15%, with pity starting at pull 180 and guaranteed by 220. Collect the rest of a region first!
- Rifts hit harder in 3–4 player co-op from the very first one, and poison no longer melts rift legends and bosses.
- Wild Pokémon no longer one-shot you in the late game: their regular hits now grow in step with your Pokémon, and upgrading still makes you tougher.

### Fixed

- Server restarts no longer stall when a player reconnects during shutdown.
- Moving through the Pokémon screen with a controller or the arrow keys goes where you expect: along the filters and up and down the grid.
- Co-op movement no longer rubberbands when input updates bunch up, and choice menus use less network traffic.

### Behind the scenes

- Added manual diagnostics for wild Pokémon damage, crowd survival and toughness through a run.

## v9 - 2026-10-14

PRs: [#56](https://github.com/callumbirks/pokesurvivor/pull/56)

### Changed

- Rift legends now get much tougher as a run goes on: mid- and late-game rifts are a real fight again.

## v8 - 2026-10-14

PRs: [#48](https://github.com/callumbirks/pokesurvivor/pull/48), [#49](https://github.com/callumbirks/pokesurvivor/pull/49), [#50](https://github.com/callumbirks/pokesurvivor/pull/50), [#51](https://github.com/callumbirks/pokesurvivor/pull/51), [#52](https://github.com/callumbirks/pokesurvivor/pull/52), [#53](https://github.com/callumbirks/pokesurvivor/pull/53)

### New

- See what your friends are up to: the Friends list and room invites show whether they're in the menus or in a solo or co-op run, with their Pokémon and run time.
- In co-op you'll hear and see it when a teammate goes down, so you can go and help.
- Find your Pokémon fast: search, filter and sort when picking a Pokémon for solo runs and in multiplayer rooms.

### Changed

- Coming back from a rift now heals everyone still standing by 30% of their max HP, as well as reviving the fallen.

### Fixed

- Upgrades now opens on your current partner after you change it.
- In a room, changing your Pokémon now shows to everyone straight away, not only once you're ready.
- Starting a solo run right after leaving a room no longer gets blocked by the old room.
- Friends see your current activity again after you reconnect.

## v7 - 2026-10-14

PRs: [#46](https://github.com/callumbirks/pokesurvivor/pull/46)

### Changed

- A bigger partner card on the main menu, and a softer selection highlight.

### Fixed

- Menus scale up on large screens, the gacha screen keeps its shape on wide monitors, Esc works after using a drop-down, and the first press on a menu moves from the highlighted entry.
- Controller button prompts no longer flicker to the keyboard's when Steam Input or another remapper is running.

## v6 - 2026-10-14

PRs: [#41](https://github.com/callumbirks/pokesurvivor/pull/41), [#42](https://github.com/callumbirks/pokesurvivor/pull/42), [#43](https://github.com/callumbirks/pokesurvivor/pull/43), [#44](https://github.com/callumbirks/pokesurvivor/pull/44)

### New

- The arrow keys move through the menus and Esc goes back, like a gamepad's D-pad and B.

### Changed

- A whole new look: pixel windows across every menu and in-run screen, and your partner talks you through the main menu. Settings → About now credits everyone behind the game, music included.
- Controller button prompts are twice as big and easier to read, in the menus and in runs.

## v5 - 2026-10-14

PRs: [#32](https://github.com/callumbirks/pokesurvivor/pull/32), [#33](https://github.com/callumbirks/pokesurvivor/pull/33), [#34](https://github.com/callumbirks/pokesurvivor/pull/34), [#35](https://github.com/callumbirks/pokesurvivor/pull/35), [#36](https://github.com/callumbirks/pokesurvivor/pull/36), [#37](https://github.com/callumbirks/pokesurvivor/pull/37), [#38](https://github.com/callumbirks/pokesurvivor/pull/38)

### New

- What's new: a new button on the main menu lists every update. A dot shows when there's one you haven't read.
- The results screen shows what your achievements paid out, in solo and co-op.
- Pick the manual-aim crosshair's colour and size in Settings → Controls.
- Play the menus with a gamepad: the D-pad or stick moves through every menu and level-up choice, and button prompts match your controller.

### Changed

- HUD size is Auto by default and grows with the window, or pick a fixed size from 75% to 200%.
- The crosshair is magenta by default and no longer changes colour while you fire.
- In co-op, when a teammate goes down or leaves, their enemies now come for you gradually over 10–20 seconds instead of all at once.
- Server updates no longer close multiplayer lobbies: you reconnect to the same room automatically. Games in progress still finish as before.

### Fixed

- The HUD size slider can be dragged all the way again.

### Behind the scenes

- Each release now gets a version number, shown in Settings, and a changelog.

## v4 - 2026-10-14

PRs: [#28](https://github.com/callumbirks/pokesurvivor/pull/28), [#29](https://github.com/callumbirks/pokesurvivor/pull/29), [#30](https://github.com/callumbirks/pokesurvivor/pull/30), [#31](https://github.com/callumbirks/pokesurvivor/pull/31)

### New

- The in-run HUD grows on large screens, and Settings → Graphics has a HUD size option.

### Changed

- Enemy healers are weaker: they heal only part of the damage you deal, fewer enemies at a time, and never bosses or shielded enemies.
- Healed enemies show a heal effect, so you can see who's being healed.

### Fixed

- Reward menus ignore clicks and keys for a moment after they appear, so you can't pick a reward by accident.

## v3 - 2026-10-14

PRs: [#26](https://github.com/callumbirks/pokesurvivor/pull/26), [#27](https://github.com/callumbirks/pokesurvivor/pull/27)

### New

- Manual aim on desktop: a crosshair follows the mouse, and holding the left button (or the right trigger) fires even with no enemy in range.

### Behind the scenes

- The original game's code was retired and automated checks are faster.

## v2 - 2026-10-14

PRs: [#24](https://github.com/callumbirks/pokesurvivor/pull/24), [#25](https://github.com/callumbirks/pokesurvivor/pull/25)

### New

- Manual aim: point your attacks with the mouse, a second touch stick or the gamepad's right stick. Switch with T, the AIM button or Settings → Controls.

### Changed

- Enemy shields are weaker, last less long and cover fewer enemies, and a blue bar shows how much shield is left.

## v1 - 2026-10-14

PRs: [#1](https://github.com/callumbirks/pokesurvivor/pull/1), [#2](https://github.com/callumbirks/pokesurvivor/pull/2), [#3](https://github.com/callumbirks/pokesurvivor/pull/3), [#4](https://github.com/callumbirks/pokesurvivor/pull/4), [#5](https://github.com/callumbirks/pokesurvivor/pull/5), [#6](https://github.com/callumbirks/pokesurvivor/pull/6), [#7](https://github.com/callumbirks/pokesurvivor/pull/7), [#8](https://github.com/callumbirks/pokesurvivor/pull/8), [#9](https://github.com/callumbirks/pokesurvivor/pull/9), [#10](https://github.com/callumbirks/pokesurvivor/pull/10), [#11](https://github.com/callumbirks/pokesurvivor/pull/11), [#12](https://github.com/callumbirks/pokesurvivor/pull/12), [#13](https://github.com/callumbirks/pokesurvivor/pull/13), [#14](https://github.com/callumbirks/pokesurvivor/pull/14), [#15](https://github.com/callumbirks/pokesurvivor/pull/15), [#16](https://github.com/callumbirks/pokesurvivor/pull/16), [#17](https://github.com/callumbirks/pokesurvivor/pull/17), [#18](https://github.com/callumbirks/pokesurvivor/pull/18), [#19](https://github.com/callumbirks/pokesurvivor/pull/19), [#20](https://github.com/callumbirks/pokesurvivor/pull/20), [#21](https://github.com/callumbirks/pokesurvivor/pull/21), [#23](https://github.com/callumbirks/pokesurvivor/pull/23)

### New

- PokéSurvivor is here: survive waves of wild Pokémon with your partner, alone or in co-op with up to 3 friends.
- A personality test picks your first partner. Collect over 900 Pokémon and their shinies through the gacha.
- Level up during a run to learn, upgrade and evolve moves, pick up held items and form bonds.
- Rifts lead to legendary arenas, and weather, events, chests and altars change every run.
- Spend PokéCoins on permanent upgrades, including move bans and move slots.
- Daily and weekly missions, achievements, leaderboards and friends.
- Resume a solo run after closing the tab or reloading.
- Play with a keyboard and mouse, a gamepad, or touch on phones and tablets.

### Behind the scenes

- Rebuilt from the ground up: the server runs co-op games and keeps your progress in your account.
