# Branch protection and repository settings

These settings live in the GitHub UI (and one `gh secret set`), not in YAML — apply them once,
by hand, as the repository owner. `.github/workflows/ci.yml`, `release.yml` and
`upstream-check.yml` assume every setting below is in place; without them, auto-merge silently
never fires and `release.yml`'s CHANGELOG PR job fails at its first step.

Run `scripts/repo-setup.sh` first (see "Labels" below) — several steps here depend on the labels
it creates already existing.

## Ruleset `protect-main-and-qa`

Settings → Rules → Rulesets → New branch ruleset:

- Ruleset name: `protect-main-and-qa`
- Enforcement status: **Active**
- Target branches: `main` and pattern `qa/**` (the `qa/**` pattern lets the final QA procedure
  exercise the upstream bot and its auto-merge end-to-end against a non-release branch)
- Bypass list: **empty** — nobody, including the repository owner, bypasses these rules; every
  write to `main` goes through a PR, including the release workflow's own CHANGELOG commit
- Rules:
  - [x] Restrict deletions
  - [x] Require a pull request before merging
    - Required approvals: **0** (the upstream bot and the release workflow's CHANGELOG PR must be
      able to merge without a human reviewer)
    - Dismiss stale reviews on push: off
    - Require review from Code Owners: off
    - Require conversation resolution before merging: off
  - [x] Require status checks to pass
    - Required check: **`ci-status`** — this is the only check any workflow in this repository
      requires; `lint-unit` and `build-and-test` feed into it but are not required directly, so
      the docs-only fast path (where `build-and-test` is skipped) still satisfies the rule
    - "Require branches to be up to date before merging": **off** — with this on, a bot PR that
      sits open overnight would need a rebase before every merge, which the bot does not do
  - [x] Block force pushes

## General settings

Settings → General → Pull Requests:

- Only **Allow squash merging** enabled (merge commits and rebase merging off)
- Default commit message for squash merges: **"Pull request title and description"**
- [x] Allow auto-merge
- [x] Automatically delete head branches

Settings → Actions → General → Workflow permissions:

- "Read and write permissions" for the default `GITHUB_TOKEN` is **not** required — every
  workflow in this repository declares its own least-privilege `permissions:` block, and the two
  jobs that need to push or open PRs (`upstream-check.yml`'s `check` job, `release.yml`'s
  `changelog` job) use the `UPSTREAM_BOT_TOKEN` secret instead, deliberately, so their PRs
  trigger `ci.yml`'s `pull_request` event (a `GITHUB_TOKEN`-authored PR never does)
- [x] **Allow GitHub Actions to create and approve pull requests** — required by spec §13; note
  it governs the default `GITHUB_TOKEN` only. The `gh pr create` / `gh pr merge --auto` calls in
  `upstream-check.yml` and `release.yml`'s `changelog` job run entirely under
  `UPSTREAM_BOT_TOKEN`, so they do not depend on this setting — leave it on regardless, since a
  future job using `GITHUB_TOKEN` for PR actions would otherwise fail confusingly

Settings → Code security:

- CodeQL: default setup **OFF**. This repository uses `.github/workflows/codeql.yml` (an
  "Advanced" configuration); GitHub refuses to run default setup alongside an advanced workflow,
  so default setup must stay disabled or the advanced workflow's runs are rejected.

## Secrets

Settings → Secrets and variables → Actions:

- `UPSTREAM_BOT_TOKEN` — fine-grained PAT of the repository owner, scoped to this repository only:
  Contents read/write, Pull requests read/write, Issues read/write, Workflows read/write. Used by
  `upstream-check.yml` (all of its git/gh writes) and by the `changelog` job of `release.yml`
  (the CHANGELOG-finalization PR). See [`docs/RELEASING.md`](RELEASING.md#rotating-upstream_bot_token)
  for the rotation procedure.

## Labels

`scripts/repo-setup.sh` creates (and is safe to re-run to update the colors of):
`needs-human`, `automerge`, `upstream-bump`, `dependencies`, `qa-defect`, `packaging`, `bug`.

```bash
scripts/repo-setup.sh            # create/update the labels on sams-git-195/qwenstudio-linux
scripts/repo-setup.sh --dry-run  # print what would change, no API calls
```

Run it once against a new repository, and again any time a label listed above is missing. Two
workflows have a best-effort fallback if a label is gone — `release.yml`'s `changelog` job
recreates `automerge`, and `ci.yml`'s `flag-needs-human` recreates `needs-human` — but nothing
recreates `upstream-bump`, `dependencies`, `qa-defect`, `packaging` or `bug`, so treat this script's
output as the source of truth rather than relying on any workflow's fallback.

## Maintenance

- **Scheduled workflows auto-disable.** GitHub disables a `schedule` trigger after 60 days with
  no repository activity. If upstream is quiet for two months and nothing else gets pushed,
  `upstream-check.yml`'s nightly run silently stops until someone re-enables it from the Actions
  tab (any push resets the clock). Check the Actions tab periodically, or after any long quiet
  period, to confirm `upstream-check` is still enabled.

## Verification checklist

Run these after applying the settings above (or periodically, to confirm nothing drifted):

```bash
# Ruleset exists; then fetch its detail to confirm ci-status is actually required
gh api repos/sams-git-195/qwenstudio-linux/rulesets
RULESET_ID=$(gh api repos/sams-git-195/qwenstudio-linux/rulesets \
  -q '.[] | select(.name=="protect-main-and-qa") | .id')
gh api "repos/sams-git-195/qwenstudio-linux/rulesets/$RULESET_ID" \
  -q '.enforcement, .conditions.ref_name.include, .rules[] | select(.type=="required_status_checks")'

# Auto-merge is allowed
gh api repos/sams-git-195/qwenstudio-linux -q .allow_auto_merge
# -> true

# Squash-only merges
gh api repos/sams-git-195/qwenstudio-linux -q '.allow_squash_merge, .allow_merge_commit, .allow_rebase_merge'
# -> true, false, false

# The bot secret is configured
gh secret list
# -> UPSTREAM_BOT_TOKEN   ...

# The labels the workflows depend on exist
gh label list
# -> needs-human, automerge, upstream-bump, dependencies, qa-defect, packaging, bug

# The bot runs cleanly end-to-end without writing anything
gh workflow run upstream-check.yml -f dry_run=true
# then check the run's log: either "Up to date (feed ..., local ...)" or a "[dry-run]" plan

# The docs-only fast path works: open a PR that only touches a file under docs/, confirm
# build-and-test is skipped and ci-status still goes green in ~1-2 minutes.
```
