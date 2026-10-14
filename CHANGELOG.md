# Changelog

What changed for players in each release, newest first. Generated from
`packages/data/changelog.json` by `pnpm changelog`: edit the JSON, not this file. See
[CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add entries.

## Unreleased

### Changed

- Coming back from a rift now heals everyone still standing by 30% of their max HP, as well as reviving the fallen.

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
