## Agent skills

### Issue tracker

Issues live in GitHub Issues (`archer-trek/waypoint`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

### Git & branches

Cut `<type>/<issue>-<slug>` branches from `origin/main` and land via squash PR (`main` updates through PRs only). Read `docs/agents/git-workflow.md` when creating branches, rebasing, committing, opening or merging PRs, or running parallel worktrees.
