# Releasing

Releases are fully automatic once a version-changing change lands on `main`. This page explains
the normal flow, the version scheme, how to ship changes that do and don't trigger a release, and
the manual recoveries for when a run fails partway through. It describes what
`.github/workflows/release.yml` and `.github/workflows/upstream-check.yml` actually do; see those
files' header comments for the full rationale behind each decision.

Prerequisite: `scripts/repo-setup.sh` has been run once against the repository (creates the
labels these workflows depend on) and the settings in [`docs/BRANCH_PROTECTION.md`](BRANCH_PROTECTION.md)
are applied. Without them, `release.yml`'s `changelog` job and `upstream-check.yml` can still
open PRs, but auto-merge will not fire.

## Normal flow

1. **`upstream-check.yml`** runs nightly at 04:17 UTC (cron `17 4 * * *`), or on demand via
   `gh workflow run upstream-check.yml`. It compares
   `https://download.qwen.ai/windows/x64/latest.yml` against `upstream.json`. If upstream is not
   newer, it logs `Up to date` and exits — no branch, no PR, no cache write. If upstream is newer,
   it runs five pre-flight checks: the installer downloads and its SHA-512 matches the feed, it
   extracts cleanly (NSIS → `app-64.7z` → `app.asar`), the app.asar `package.json` version
   matches the feed, the embedded Electron version matches `sidecars.json`, and every patch in
   `patches/` applies cleanly (`git apply --check`) against the new `out/main/index.js`. It then
   updates `upstream.json` (`wrapper_revision` reset to `1`), refreshes
   `tests/fixtures/app-pristine/out/main/index.js`, adds a `CHANGELOG.md` entry under
   `## [Unreleased]`, and pushes branch `upstream/<base_branch>/v<version>.<build>` with a PR
   labelled `upstream-bump`.
2. If all five pre-flight checks passed, the PR also gets `automerge` and the bot arms
   `gh pr merge --auto --squash`. `ci.yml` runs on the PR (the bot's own PAT, not `GITHUB_TOKEN`,
   opens it, so `pull_request` events fire); when the single required check `ci-status` is green,
   GitHub squash-merges it onto `main`. If any check failed, the PR instead gets `needs-human`, no
   auto-merge, and a comment with the failing check's output — a maintainer must fix the branch
   (see "Patches no longer apply" / "Upstream changed Electron" below) or close the PR.
3. **`release.yml`** runs on every push to `main` (and via `workflow_dispatch`). Its `plan` job
   derives the tag with `npm run -s version -- --print gitTag` and checks
   `git ls-remote --tags origin refs/tags/<tag>`. If the tag already exists, the run ends with
   `::notice::Tag <tag> already exists; nothing to release` and nothing else runs — this is what
   makes docs-only merges, Dependabot bumps, and the workflow's own CHANGELOG PR (step 4 below) a
   no-op. If the tag is new, `build-and-test` (the same reusable workflow `ci.yml` uses) rebuilds
   and runs the full install matrix, and `publish` downloads those exact artifacts, writes
   `dist/SHA256SUMS`, renders release notes from the CHANGELOG's `Unreleased` section
   (`npm run -s changelog -- --release-notes dist/SHA256SUMS`) with GitHub's auto-generated notes
   appended, creates an annotated tag on the built commit, and runs
   `gh release create --verify-tag --latest` with the `.deb`, `.rpm`, `.AppImage` and
   `SHA256SUMS`. `latest-linux.yml` is uploaded **last**, in a separate `gh release upload`, so an
   electron-updater client never sees the YAML before the AppImage it points to exists. The
   release is never a draft or a prerelease and is always marked latest. Finally it runs
   `actions/attest-build-provenance@v2` over the three package files.
4. The `changelog` job (`needs: [plan, publish]`) then finalizes `CHANGELOG.md` — moving
   `Unreleased` into `## [<tag>] - <date>` — on branch `release/changelog-<tag>`, and opens (or
   reuses) a PR `chore(release): changelog for <tag>` labelled `automerge`, using
   `UPSTREAM_BOT_TOKEN`. Because a PR opened with the default `GITHUB_TOKEN` never triggers
   `ci.yml`'s `pull_request` event, `ci-status` would never appear and auto-merge could never be
   satisfied — this is why the PAT is required for this job too, not only for the upstream bot.
   The PR is docs-only, so `ci.yml` runs only `lint-unit` and `ci-status` (`build-and-test` is
   skipped). When it merges, the push to `main` re-triggers `release.yml`, whose `plan` finds the
   tag already exists and skips.

## Version strings

`upstream.json` (`version`, `build`, `wrapper_revision`) is the single source of truth; every
derived string comes from `scripts/lib/versions.ts`. Example for `version: "1.0.3"`, `build: 44`,
`wrapper_revision: 1`:

| | Field | Example |
| --- | --- | --- |
| App version / `latest-linux.yml` | `appVersion` | `1.0.3-44.1` |
| `.deb` `Version` | `debVersion` | `1.0.3.44-1` |
| `.rpm` `Version` / `Release` | `rpmVersion` / `rpmRelease` | `1.0.3.44` / `1` |
| Git tag / GitHub Release | `gitTag` | `v1.0.3.44-1` |
| Release title | `releaseName` | `Qwen Studio 1.0.3.44 (linux-1)` |

`wrapper_revision` is what makes the tag (and therefore a release) change without a new upstream
version — see below.

## Shipping a wrapper-only change

Open a PR that increments `wrapper_revision` in `upstream.json` and adds a line under
`## [Unreleased]` in `CHANGELOG.md`. Merging it changes the derived tag (e.g. `v1.0.3.44-1` →
`v1.0.3.44-2`), so the next `release.yml` run on `main` builds and publishes it. Merging a
wrapper change **without** bumping `wrapper_revision` produces no new tag and therefore no
release — `plan` will find the existing tag and skip. This includes an edit to `sidecars.json`
alone (a `bun`/`uv`/`electron` version bump with no matching `wrapper_revision` bump): the tag is
derived only from `upstream.json` (`scripts/lib/versions.ts`), so a `sidecars.json`-only PR
merges cleanly but releases nothing until `wrapper_revision` is also bumped.

## Shipping a new upstream version

Normally this is entirely the bot's job (see "Normal flow" above). To do it by hand instead —
for example if the feed is unreachable from Actions, or to release faster than the next
04:17 UTC run — reproduce what `scripts/upstream-check.ts`'s `realWriteWorkspace` does, in a PR:

- Edit `upstream.json`: `version`, `build`, `url`, `sha512`, `size`, `releaseDate` from the feed
  at `https://download.qwen.ai/windows/x64/latest.yml`; `wrapper_revision` reset to `1`.
- Add a `CHANGELOG.md` line under `## [Unreleased]`, e.g.
  `npm run changelog -- --add "Upstream bump to <version>.<build> (released <releaseDate>)"`.
- Replace `tests/fixtures/app-pristine/out/main/index.js` with the new upstream file's
  `out/main/index.js` (extract it the same way the bot does — see `npm run patches:dev` below).
  This fixture is what `npm run test:unit` and the bot's own pre-flight checks diff patches
  against; leaving it stale means the next `test:unit` run (and the next nightly bot run) checks
  patches against the wrong upstream.

Also verify the patches still apply (`npm run patches:dev`) and that the embedded Electron
version still matches `sidecars.json` before merging — the bot's pre-flight checks exist
specifically to catch these two things automatically; skipping them manually risks a release
that fails to build or ships a broken app.

## Upstream changed Electron

The bot's PR carries label `needs-human` and a comment with an output like:

```text
Qwen.exe embeds Electron 36.0.0 but sidecars.json pins 35.1.4.
The bot never edits sidecars.json: a maintainer must update electron.version/url/sha256 on this branch.
```

The bot never edits `sidecars.json` under any circumstances — this is a deliberate safety
property (`scripts/upstream-check.ts`), not a bug. On the bot's branch (or a fresh branch off it):

1. Update `sidecars.json`'s `electron` entry: `version`, `url`, and `sha256` (from Electron's
   official `SHASUMS256.txt` for that release's `electron-v<version>-linux-x64.zip`). `bun` and
   `uv` are unrelated to a Qwen/Electron bump and are not touched by this procedure. Nothing else
   needs editing: `electron-builder`'s `electronVersion` is derived from this same file at build
   time (`scripts/lib/electron-builder-config.ts`), not hardcoded in the packaging config. The
   branch already carries a `wrapper_revision: 1` bump in `upstream.json` from the bot's own
   commit, so this edit alone is enough to make the branch release once it merges — no separate
   version bump needed here.
2. Re-run the pre-flight checks locally (`npm run patches:dev`, `npm run test:unit`) to confirm
   the new Electron version doesn't also break a patch.
3. Push, remove `needs-human`, add `automerge`, and run `gh pr merge --auto --squash <pr>` (or
   let a maintainer do the equivalent merge by hand).

To update `sidecars.json` on its own, with no matching upstream version change (for example a
security-only Electron point release), also bump `wrapper_revision` in `upstream.json` — see
"Shipping a wrapper-only change" above — or the merge produces no new tag.

## Patches no longer apply

The bot's PR carries `needs-human` with the `git apply` failure output. Locally, on the bot's
branch:

```bash
npm run patches:dev        # fails at the patch step against the new pristine app
# fix build/app/out/main/index.js by hand
npm run patches:export -- 0001
npm run patches:export -- 0002
npm run test:unit
git add patches/ && git commit
git push
```

Then remove `needs-human`, add `automerge`, and merge as above.

## Manual re-run

`gh workflow run release.yml` (or the "Run workflow" button) re-evaluates `main`. It is a no-op
— `plan` skips immediately — whenever the tag currently derived from `upstream.json` already
exists on origin. `plan` also hard-errors if dispatched against anything other than `main`
(`refs/heads/main`), so a `workflow_dispatch` on `qa/**` or any other branch fails immediately by
design — releases are cut from `main` only. Re-running the *same* run's failed jobs (via "Re-run
failed jobs" in the Actions UI) is different from dispatching a *new* run: see "Partial release
recovery" below.

## Partial release recovery

`release.yml` is written so re-running the same run's failed `publish` job is always safe: the
tag is reused if it already exists, an existing GitHub Release has its assets re-uploaded with
`--clobber`, and the CHANGELOG PR step is skipped if `main` already has the tag's section. Try
**"Re-run failed jobs" on the original run first** — it is the zero-touch recovery path and
covers, for example, a transient `gh release create` failure or an interrupted attestation step.

If that isn't possible (the run's artifacts expired, or you need a clean slate), or the tag was
pushed but the release is missing/partial, recover by deleting both the release and the tag and
starting a **new** run — `plan` will otherwise see the tag and skip:

```bash
gh release delete v1.0.3.44-1 --yes
git push --delete origin v1.0.3.44-1
gh workflow run release.yml
```

The workflow never resumes a partial release on its own; it always either finds the tag (and
skips) or starts a full run from `plan`.

## Rotating `UPSTREAM_BOT_TOKEN`

Both `upstream-check.yml` and the `changelog` job of `release.yml` need a fine-grained PAT of the
repository owner because PRs and pushes made with the default `GITHUB_TOKEN` never trigger
`ci.yml`'s `pull_request` event, so the required `ci-status` check would never appear and
auto-merge could never be satisfied.

1. Create a fine-grained personal access token (owner account), scoped to this repository only,
   with:
   - Contents: read and write
   - Pull requests: read and write
   - Issues: read and write (the upstream bot files/comments on failure issues and edits PR
     labels, which is an Issues permission)
   - Workflows: read and write (so a bump branch may contain workflow-file changes without the
     push being refused)
2. Store it as the repository Actions secret `UPSTREAM_BOT_TOKEN`
   (Settings → Secrets and variables → Actions).
3. Verify with a dry run: `gh workflow run upstream-check.yml -f dry_run=true`, then check the
   run's log ends with either `Up to date (feed ..., local ...)` or a `[dry-run]` plan — not the
   `secrets.UPSTREAM_BOT_TOKEN is not set` error.

If the secret is ever unset (forked repo, accidental deletion), both workflows fail fast with a
clear `::error::` before doing any checkout or network work, and `release.yml`'s `publish` job —
which does not need the PAT — still completes; only the CHANGELOG PR is blocked, with the error
message pointing at `npm run changelog -- --finalize <tag>` as the manual fallback.
