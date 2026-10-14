# Contributing

Run `pnpm lint && pnpm typecheck && pnpm test` before committing; see the [README](README.md)
for setup and [CLAUDE.md](CLAUDE.md) for the conventions.

## Changelog

Players read the changelog in the game (main menu → What's new), so it is written for them. The
source is [`packages/data/changelog.json`](packages/data/changelog.json); `CHANGELOG.md` is
generated from it.

**Every pull request that changes something players notice** adds one or two lines to
`unreleased.entries` and its PR number to `unreleased.prs`:

```json
"unreleased": {
  "prs": [31, 42],
  "entries": {
    "new": ["Pick the crosshair's colour in Settings → Controls."],
    "changed": [],
    "fixed": ["The HUD size slider can be dragged all the way again."],
    "behindTheScenes": []
  }
}
```

- **Sections:** `new` (features), `changed` (different behaviour or balance), `fixed` (bugs), and
  `behindTheScenes` for work players don't see directly (performance, servers). The game shows
  the last one collapsed.
- **Lines:** one short sentence in plain English about what the player sees, not how it was
  done. No PR numbers, file names or jargon.
- Refactors, tests, tooling and docs need no line. Nothing enforces this in CI; reviewers check
  it.
- Open the PR first if you need its number, then add it in a follow-up commit.
- Run `pnpm changelog` afterwards to regenerate `CHANGELOG.md` (`pnpm lint` fails until you do).

Don't edit released versions except to fix a typo. `pnpm release` turns `unreleased` into the
next version when deploying: see [docs/deploy.md](docs/deploy.md#releasing-a-version).
