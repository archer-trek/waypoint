## Agent skills

### Issue tracker

Issues live in GitHub Issues (`archer-trek/waypoint`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

### Git & branches

Cut `<type>/<issue>-<slug>` (or `<type>/<slug>` for standalone changes) branches from `origin/main` and land via squash PR (`main` updates through PRs only). Read `docs/agents/git-workflow.md` when creating branches, rebasing, committing, opening or merging PRs, or running parallel worktrees.

### Coding standards

Read `CODING_STANDARDS.md` when reviewing changes, updating `src/App.css` or `src/lib/overlay-scrollbars.ts`, updating icons/assets, or modifying UI components and integration tests.

### Android build

Build single-ABI (`arm64-v8a`) signed test APK via `make build-android-apk` (or `make apk`, optional `OUT=<path>`). Default Android SDK/NDK and Java 17 paths are pre-configured in `Makefile` and `scripts/build-android-apk.mjs`.

### macOS build

Build macOS `.dmg` (Apple Silicon `aarch64-apple-darwin` by default, ad-hoc signed unless `APPLE_SIGNING_IDENTITY` is set) on macOS via `make build-macos-dmg` (or `make dmg`, optional `OUT=<path>`, `TARGET=arm64|universal|x64`) or `node scripts/build-macos-dmg.mjs`.
