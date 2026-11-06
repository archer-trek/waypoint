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
