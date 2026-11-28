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

Build single-ABI (`arm64-v8a`) APK via `make build-android-apk` (or `make apk`, optional `OUT=<path>`, `OUT_DIR=<dir>`, `VERSION=X.Y.Z`, `BUILD_NUMBER=<int>`, `RELEASE=1`, `UNSIGNED=1`) or `node scripts/build-android-apk.mjs`. CI signs with the existing release keystore from Actions secrets (`WAYPOINT_ANDROID_KEYSTORE_BASE64` plus the password secrets); do not upload an unsigned APK. Running `npm ci`/`npm install` automatically activates `core.hooksPath=.githooks`.

### macOS build

Build macOS `.dmg` (Apple Silicon `aarch64-apple-darwin` by default, ad-hoc signed unless `APPLE_SIGNING_IDENTITY` is set) on macOS via `make build-macos-dmg` (or `make dmg`, optional `OUT=<path>`, `TARGET=arm64|universal|x64`, `BUILD_NUMBER=<int>`) or `node scripts/build-macos-dmg.mjs`.

### Windows build

Build Windows NSIS installer (`.exe`, `x86_64-pc-windows-msvc` / `x64` by default, `arm64` optional, unsigned by default unless `WINDOWS_SIGN_COMMAND` or `WINDOWS_CERTIFICATE_THUMBPRINT` is set) on Windows via `make build-windows-installer` (or `make win`, optional `OUT=<path>`, `TARGET=x64|arm64`) or `node scripts/build-windows-installer.mjs`.

### Release

Prepare a release PR branch (`chore/release-vX.Y.Z`) via `npm run release:prepare -- <patch|minor|major|X.Y.Z>` (or `make release-prepare VERSION=<...> [PR=1]`, or `.github/workflows/release-prepare.yml`). After squash-merging into `main` and `CI` passes, create and push the `vX.Y.Z` tag via `npm run release:tag` (or `make release-tag`) to trigger `.github/workflows/release.yml` (Android `arm64-v8a` APK + macOS DMG + Windows NSIS `.exe` -> Draft GitHub Release). See `docs/adr/0038-unified-multi-platform-release-workflow.md`.
