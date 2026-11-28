# Git & Branch Workflow

Branching, commit, and pull-request conventions for `archer-trek/waypoint`.

## Base branch

- `main` stays green and updates exclusively through pull requests.
- Before starting implementation (including `/implement`), check the current branch: if on `main`, run `git fetch origin main` and cut a new branch from `origin/main` before making commits.

## Branch naming

| Branch pattern | Purpose | Merges into `main`? |
| --- | --- | --- |
| `<type>/<issue>-<slug>` | Standard ticket work (`feat/12-route-graph`, `fix/15-null-coord`, `refactor/...`, `docs/...`, `chore/...`) | Yes, via squash PR |
| `<type>/<slug>` | Small standalone change with no tracking issue | Yes, via squash PR |
| `epic/<issue>-<slug>` | Integration branch for multi-ticket efforts or wide expand–contract refactors; child branches target `epic/*` first, then `epic/*` opens one PR to `main` | Yes, via squash PR |
| `research/<slug>` | Throwaway investigation artifact pushed by `/wayfinder` | Never (push only, open no PR) |
| `prototype/<slug>` | Runnable design spike kept as a primary source by `/prototype` | Never (push only, open no PR) |

## Commits & syncing

- Use concise Conventional Commits referencing the issue number so `/code-review` resolves the originating spec automatically:
  - `feat: parse GPX waypoints (#12)`
  - `fix: handle empty elevation array (#15)`
- Keep history linear: sync a working branch with `git fetch origin main && git rebase origin/main` (merge commits are disabled on this repository).

## Pull requests & merging

- Open PRs with `gh pr create`. Reference the issue in the PR body:
  - `Closes #<issue>` when the PR completes the ticket.
  - `Part of #<issue>` when landing a slice of a larger parent issue.
- Land PRs with squash merge and clean up the working branch: `gh pr merge --squash --delete-branch` (automatic head-branch deletion on merge is enabled on GitHub).

## Parallel work

- When multiple `ready-for-agent` tickets are in flight simultaneously, give each branch its own `git worktree` rather than switching branches in a shared working directory.

## Release workflow

Releases use a two-stage PR + tag flow documented in [ADR-0038](../adr/0038-unified-multi-platform-release-workflow.md):

1. Cut a release preparation branch (`chore/release-vX.Y.Z`) and synchronize all five version/lockfile entries (`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`):
   - Local CLI: `npm run release:prepare -- <patch|minor|major|X.Y.Z>` (add `--pr` to push and open the PR, or use `make release-prepare VERSION=... PR=1`).
   - GitHub Actions: dispatch `.github/workflows/release-prepare.yml` from `main`.
2. Merge the release PR into `main` via squash merge and wait for `CI` on `main` to pass.
3. Tag `main` and trigger `.github/workflows/release.yml`:
   - `npm run release:tag` (or `make release-tag`) verifies clean `main` parity with `origin/main`, version consistency, tag uniqueness, and passing `CI` on `HEAD`, then pushes annotated tag `vX.Y.Z`.
   - `release.yml` runs `verify`, `rust-checks`, and parallel `build-android`, `build-macos`, and `build-windows` jobs, then creates or updates the Draft GitHub Release with `SHA256SUMS.txt`.
