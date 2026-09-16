// Upstream-tracking bot (spec §12.3). Runs unattended from upstream-check.yml: reads the
// Windows update feed, and when it names a newer Qwen Studio than upstream.json, runs the
// pre-flight checks, then creates/updates ONE branch + ONE PR per upstream version.
//
// Safety properties (see the report for the reasoning):
//   - never writes to `main` (or any base branch): the only branch it touches is
//     `upstream/<base>/v<version>.<build>`, and it refuses to push anywhere else;
//   - idempotent: every run rebuilds that branch from the freshly fetched `origin/<base>`,
//     re-checks that the base does not already carry the bump, pushes only if the resulting
//     tree differs from what is on the remote branch, and reuses the existing open PR (only
//     reconciling labels/auto-merge on unchanged re-runs) instead of opening a duplicate;
//   - `--dry-run` performs every check but makes no git/gh/worktree writes;
//   - `sidecars.json` is never modified -- an Electron change is reported and labelled
//     `needs-human`;
//   - all side effects go through the injectable `Deps` so the orchestration is unit-testable.
import { readFileSync, writeFileSync, copyFileSync, statSync, mkdirSync, rmSync, cpSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import semver from "semver";
import * as asar from "@electron/asar";
import { parseFeed, readUpstream, readSidecars, validateUpstream, type FeedInfo, type UpstreamManifest } from "./lib/manifest.js";
import { fetchCached } from "./lib/download.js";
import { run } from "./lib/exec.js";
import { ROOT, BUILD_DIR, CACHE_DIR, PATCHES_DIR } from "./lib/paths.js";
import { detectElectronVersion } from "./extract.js";
import { gitApply, listPatches } from "./patch.js";

export const DEFAULT_FEED = "https://download.qwen.ai/windows/x64/latest.yml";
export const DEFAULT_REPO = "sams-git-195/qwenstudio-linux";
export const FIXTURE_INDEX_JS = "tests/fixtures/app-pristine/out/main/index.js";
export const LABEL_BUMP = "upstream-bump";
export const LABEL_AUTOMERGE = "automerge";
export const LABEL_NEEDS_HUMAN = "needs-human";

export const CHECK_DOWNLOAD = "installer downloads and SHA-512 matches the feed";
export const CHECK_EXTRACT = "installer extracts (NSIS -> app-64.7z -> app.asar)";
export const CHECK_APP_VERSION = "app.asar package.json version matches the feed";
export const CHECK_ELECTRON = "Electron version matches sidecars.json";
export const CHECK_PATCHES = "patches apply (git apply --check against the new pristine app)";

export type CheckResult = { name: string; ok: boolean; output: string };

// ---------------------------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------------------------

export function compareUpstream(a: { version: string; build: number }, b: { version: string; build: number }): -1 | 0 | 1 {
  const c = semver.compare(a.version, b.version);
  if (c !== 0) return c as -1 | 1;
  return a.build === b.build ? 0 : a.build > b.build ? 1 : -1;
}

export function branchName(base: string, version: string, build: number): string {
  return `upstream/${base}/v${version}.${build}`;
}

export function nextManifest(feed: FeedInfo): UpstreamManifest {
  return validateUpstream({
    version: feed.version, build: feed.build, wrapper_revision: 1,
    url: feed.url, sha512: feed.sha512, size: feed.size, releaseDate: feed.releaseDate,
  });
}

export function prTitle(feed: { version: string; build: number }): string {
  return `chore(upstream): bump Qwen Studio to ${feed.version}.${feed.build}`;
}

export function changelogLine(feed: { version: string; build: number; releaseDate: string }): string {
  return `Upstream bump to ${feed.version}.${feed.build} (released ${feed.releaseDate})`;
}

function indentBlock(text: string): string {
  return `\n\n  \`\`\`\n  ${text.trim().split("\n").join("\n  ")}\n  \`\`\``;
}

export function renderPrBody(a: { feed: FeedInfo; checks: CheckResult[]; electronDetected?: string }): string {
  const lines = [
    `Automated upstream bump to Qwen Studio **${a.feed.version}.${a.feed.build}**.`,
    ``,
    `- Installer: ${a.feed.url}`,
    `- SHA-512: \`${a.feed.sha512}\``,
    `- Upstream release date: ${a.feed.releaseDate}`,
    ...(a.electronDetected ? [`- Electron embedded in Qwen.exe: ${a.electronDetected}`] : []),
    ``,
    `### Pre-flight checks`,
    ``,
    ...a.checks.map((c) => `- [${c.ok ? "x" : " "}] ${c.name}${c.output.trim() ? indentBlock(c.output) : ""}`),
    ``,
    `CI: pending`,
    ``,
    `_Opened by the upstream-check workflow. If all checks and CI pass, this PR auto-merges and a release is published. The bot never edits \`sidecars.json\`; a failed check means a maintainer must fix this branch._`,
  ];
  return lines.join("\n");
}

export interface Decision { autoMerge: boolean; addLabels: string[]; removeLabels: string[] }

/** Labels/auto-merge for a set of pre-flight results. Auto-merge only when every check passed. */
export function decide(checks: CheckResult[]): Decision {
  const allOk = checks.length > 0 && checks.every((c) => c.ok);
  return allOk
    ? { autoMerge: true, addLabels: [LABEL_BUMP, LABEL_AUTOMERGE], removeLabels: [LABEL_NEEDS_HUMAN] }
    : { autoMerge: false, addLabels: [LABEL_BUMP, LABEL_NEEDS_HUMAN], removeLabels: [LABEL_AUTOMERGE] };
}

/** The comment posted on a needs-human PR; carries a marker so re-runs don't repeat it. */
export function renderFailureComment(checks: CheckResult[]): { marker: string; body: string } {
  const failing = checks.filter((c) => !c.ok);
  const digest = createHash("sha256").update(JSON.stringify(failing)).digest("hex").slice(0, 16);
  const marker = `<!-- upstream-check:failure:${digest} -->`;
  const body = [
    marker,
    `Pre-flight checks failed; a maintainer must fix this branch (or close this PR).`,
    ``,
    ...failing.map((c) => `**${c.name}**\n\`\`\`\n${c.output.trim() || "(no output)"}\n\`\`\``),
  ].join("\n");
  return { marker, body };
}

/** Refuses any branch the bot is not allowed to push. */
export function assertSafeBranch(branch: string, base: string): void {
  if (!branch.startsWith("upstream/") || branch === base || branch === "main" || branch === "master") {
    throw new Error(`refusing to push to "${branch}": the bot only pushes upstream/* branches`);
  }
}

export interface CliOptions { feedUrl: string; feedFile?: string; base: string; dryRun: boolean }

export const USAGE = "usage: upstream-check [--feed-url <url>] [--feed-file <path>] [--base-branch <branch>] [--dry-run]";

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { feedUrl: DEFAULT_FEED, base: "main", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) throw new Error(USAGE); return v; };
    if (a === "--feed-url") o.feedUrl = val();
    else if (a === "--feed-file") o.feedFile = val();
    else if (a === "--base-branch") o.base = val();
    else if (a === "--dry-run") o.dryRun = true;
    else throw new Error(USAGE);
  }
  if (!o.base) throw new Error(USAGE);
  return o;
}

// ---------------------------------------------------------------------------------------------
// Plan (pure, given the pre-flight results)
// ---------------------------------------------------------------------------------------------

export interface Preflight {
  checks: CheckResult[];
  /** Electron version found in the new Qwen.exe (undefined if extraction never got that far). */
  electronDetected?: string;
  /** Actual byte size of the verified installer (undefined if the download failed). */
  installerSize?: number;
  /** Path of the freshly extracted pristine `out/main/index.js` (undefined if extraction failed). */
  pristineIndexJs?: string;
}

export interface Plan {
  feed: FeedInfo;
  current: UpstreamManifest;
  next: UpstreamManifest;
  branch: string;
  title: string;
  body: string;
  changelogLine: string;
  checks: CheckResult[];
  decision: Decision;
  electronDetected?: string;
  pristineIndexJs?: string;
  fixtureChanged: boolean;
}

export function buildPlan(a: { feed: FeedInfo; current: UpstreamManifest; base: string; preflight: Preflight; fixtureChanged: boolean }): Plan {
  const next = nextManifest(a.feed);
  if (a.preflight.installerSize !== undefined) next.size = a.preflight.installerSize;
  return {
    feed: a.feed, current: a.current, next,
    branch: branchName(a.base, a.feed.version, a.feed.build),
    title: prTitle(a.feed),
    body: renderPrBody({ feed: a.feed, checks: a.preflight.checks, electronDetected: a.preflight.electronDetected }),
    changelogLine: changelogLine(a.feed),
    checks: a.preflight.checks,
    decision: decide(a.preflight.checks),
    electronDetected: a.preflight.electronDetected,
    pristineIndexJs: a.preflight.pristineIndexJs,
    fixtureChanged: a.fixtureChanged,
  };
}

export function renderDryRun(p: Plan): string {
  const failing = p.checks.filter((c) => !c.ok).map((c) => c.name);
  return [
    `[dry-run] no git/gh/worktree writes performed. The bot would:`,
    ``,
    `  branch:      ${p.branch}`,
    `  PR title:    ${p.title}`,
    `  labels:      ${p.decision.addLabels.join(", ")}  (remove: ${p.decision.removeLabels.join(", ")})`,
    `  auto-merge:  ${p.decision.autoMerge}${failing.length ? `  (failing: ${failing.join("; ")})` : ""}`,
    `  changelog:   - ${p.changelogLine}`,
    `  fixture:     ${FIXTURE_INDEX_JS} ${p.pristineIndexJs ? (p.fixtureChanged ? "would be replaced (content differs)" : "unchanged (identical content)") : "not refreshed (extraction did not produce it)"}`,
    ``,
    `upstream.json would become:`,
    JSON.stringify(p.next, null, 2),
    ``,
    `PR body:`,
    `----------------------------------------------------------------`,
    p.body,
    `----------------------------------------------------------------`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Side effects (injectable)
// ---------------------------------------------------------------------------------------------

export interface Deps {
  fetchText(url: string): Promise<string>;
  readFile(p: string): string;
  readUpstream(): UpstreamManifest;
  preflight(feed: FeedInfo): Promise<Preflight>;
  /** Writes upstream.json, the CHANGELOG entry and the pristine fixture; returns the repo-relative paths written. */
  writeWorkspace(w: { manifest: UpstreamManifest; changelogLine: string; pristineIndexJs?: string }): string[];
  git(args: string[]): string;
  gh(args: string[], allowFailure?: boolean): string;
  log(msg: string): void;
  error(msg: string): void;
  env: NodeJS.ProcessEnv;
}

function fresh(dir: string): void { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** Checks every patch, in order, against a scratch copy of the pristine app (each applied on success so later patches see it). */
export function checkPatches(pristineDir: string): CheckResult {
  const patches = listPatches();
  const scratch = mkdtempSync(path.join(os.tmpdir(), "qs-upstream-check-"));
  const lines: string[] = [];
  let ok = true;
  try {
    cpSync(pristineDir, scratch, { recursive: true });
    for (const p of patches) {
      const abs = path.join(PATCHES_DIR, p);
      try { gitApply(abs, scratch, true); gitApply(abs, scratch, false); lines.push(`${p}: applies cleanly`); }
      catch (e) { ok = false; lines.push(`${p}: FAILED\n${errMsg(e)}`); }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  if (patches.length === 0) { ok = false; lines.push("no patches found in patches/"); }
  return { name: CHECK_PATCHES, ok, output: lines.join("\n") };
}

/** Real pre-flight: download + verify, extract to build/upstream-check, then the three inspection checks. */
export async function realPreflight(feed: FeedInfo): Promise<Preflight> {
  const checks: CheckResult[] = [];
  const out: Preflight = { checks };
  const skip = (...names: string[]) => { for (const n of names) checks.push({ name: n, ok: false, output: "skipped: a previous check failed" }); };

  let installer: string | undefined;
  try {
    installer = await fetchCached({ url: feed.url, algo: "sha512", expected: feed.sha512, cacheDir: CACHE_DIR });
    out.installerSize = statSync(installer).size;
    checks.push({ name: CHECK_DOWNLOAD, ok: true, output: `${path.basename(installer)}: ${out.installerSize} bytes, sha512 verified (feed advertises ${feed.size} bytes; size is informational only)` });
  } catch (e) {
    checks.push({ name: CHECK_DOWNLOAD, ok: false, output: errMsg(e) });
    skip(CHECK_EXTRACT, CHECK_APP_VERSION, CHECK_ELECTRON, CHECK_PATCHES);
    return out;
  }

  const work = path.join(BUILD_DIR, "upstream-check");
  const nsisDir = path.join(work, "nsis"); const winApp = path.join(work, "win-app"); const pristine = path.join(work, "app-pristine");
  try {
    fresh(nsisDir); fresh(winApp); fresh(pristine);
    run("7z", ["x", "-y", `-o${nsisDir}`, installer, "$PLUGINSDIR/app-64.7z"], { capture: true });
    run("7z", ["x", "-y", `-o${winApp}`, path.join(nsisDir, "$PLUGINSDIR", "app-64.7z")], { capture: true });
    asar.extractAll(path.join(winApp, "resources", "app.asar"), pristine);
    for (const rel of ["package.json", "out/main/index.js"]) {
      if (!existsSync(path.join(pristine, rel))) throw new Error(`app.asar has no ${rel}`);
    }
    if (!existsSync(path.join(winApp, "Qwen.exe"))) throw new Error("app-64.7z has no Qwen.exe");
    checks.push({ name: CHECK_EXTRACT, ok: true, output: "" });
  } catch (e) {
    checks.push({ name: CHECK_EXTRACT, ok: false, output: errMsg(e) });
    skip(CHECK_APP_VERSION, CHECK_ELECTRON, CHECK_PATCHES);
    return out;
  }
  out.pristineIndexJs = path.join(pristine, "out", "main", "index.js");

  try {
    const pkg = JSON.parse(readFileSync(path.join(pristine, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    const ok = pkg.name === "Qwen" && pkg.version === feed.version;
    checks.push({ name: CHECK_APP_VERSION, ok, output: `package.json name "${String(pkg.name)}" version ${String(pkg.version)}; feed version ${feed.version}` });
  } catch (e) { checks.push({ name: CHECK_APP_VERSION, ok: false, output: errMsg(e) }); }

  try {
    const detected = detectElectronVersion(path.join(winApp, "Qwen.exe"));
    out.electronDetected = detected;
    const pinned = readSidecars(ROOT).electron.version;
    const ok = detected === pinned;
    checks.push({
      name: CHECK_ELECTRON, ok,
      output: ok
        ? `Qwen.exe embeds Electron ${detected}; sidecars.json pins ${pinned}`
        : `Qwen.exe embeds Electron ${detected} but sidecars.json pins ${pinned}.\nThe bot never edits sidecars.json: a maintainer must update electron.version/url/sha256 on this branch.`,
    });
  } catch (e) { checks.push({ name: CHECK_ELECTRON, ok: false, output: errMsg(e) }); }

  try { checks.push(checkPatches(pristine)); }
  catch (e) { checks.push({ name: CHECK_PATCHES, ok: false, output: errMsg(e) }); }
  return out;
}

export function realWriteWorkspace(w: { manifest: UpstreamManifest; changelogLine: string; pristineIndexJs?: string }): string[] {
  const written: string[] = [];
  writeFileSync(path.join(ROOT, "upstream.json"), JSON.stringify(w.manifest, null, 2) + "\n");
  written.push("upstream.json");
  run("npm", ["run", "-s", "changelog", "--", "--add", w.changelogLine], { cwd: ROOT, capture: true });
  written.push("CHANGELOG.md");
  if (w.pristineIndexJs) {
    const dest = path.join(ROOT, FIXTURE_INDEX_JS);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(w.pristineIndexJs, dest);
    written.push(FIXTURE_INDEX_JS);
  }
  return written;
}

export function realDeps(): Deps {
  return {
    async fetchText(url) {
      const res = await fetch(url, { headers: { "Cache-Control": "no-cache" }, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.text();
    },
    readFile: (p) => readFileSync(p, "utf8"),
    readUpstream: () => readUpstream(ROOT),
    preflight: realPreflight,
    writeWorkspace: realWriteWorkspace,
    git: (args) => run("git", args, { cwd: ROOT, capture: true }),
    gh: (args, allowFailure = false) => run("gh", args, { cwd: ROOT, capture: true, allowFailure }),
    log: (m) => console.log(m),
    error: (m) => console.error(m),
    env: process.env,
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

function fixtureDiffers(deps: Deps, pristineIndexJs: string | undefined): boolean {
  if (!pristineIndexJs) return false;
  try { return deps.readFile(pristineIndexJs) !== deps.readFile(path.join(ROOT, FIXTURE_INDEX_JS)); }
  catch { return true; }
}

/** Masks the bot token (and anything shaped like a GitHub token) before text reaches a public issue/comment/log. */
export function maskSecrets(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const token of [env.GH_TOKEN, env.GITHUB_TOKEN]) {
    if (token && token.length >= 8) out = out.split(token).join("***");
  }
  return out.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+|\bgithub_pat_[A-Za-z0-9_]+/g, "***");
}

/** Spec step 9: one open issue per short reason (comment on it if it already exists). Returns exit code 1. */
function reportFailure(deps: Deps, opts: CliOptions, repo: string, reason: string, rawDetail: string, feed?: FeedInfo): number {
  const title = `Upstream bot failure: ${reason.replace(/"/g, "'")}`;
  const detail = maskSecrets(rawDetail, deps.env);
  deps.error(`${title}\n${detail}`);
  if (opts.dryRun) { deps.error("[dry-run] would open/update a needs-human issue with the above"); return 1; }
  const runUrl = `${deps.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${deps.env.GITHUB_RUN_ID ?? "local"}`;
  const body = maskSecrets([
    `The scheduled upstream check failed.`, ``,
    `**Upstream version/build:** ${feed ? `${feed.version}.${feed.build}` : "unknown (failed while reading the feed)"}`,
    `**Feed URL:** ${opts.feedFile ?? opts.feedUrl}`,
    `**What failed:** other -- ${reason}`, ``,
    `**Logs:**`, "```", detail.slice(-4000), "```", ``,
    `Run: ${runUrl}`,
  ].join("\n"), deps.env);
  try {
    const existing = deps.gh(["issue", "list", "--repo", repo, "--state", "open", "--search", `in:title "${title}"`,
      "--json", "number,title", "--jq", `.[] | select(.title == "${title}") | .number`]).trim().split("\n")[0];
    if (existing) deps.gh(["issue", "comment", existing, "--repo", repo, "--body", body]);
    else deps.gh(["issue", "create", "--repo", repo, "--title", title, "--label", LABEL_NEEDS_HUMAN, "--body", body]);
  } catch (e) { deps.error(`could not open/update the failure issue: ${maskSecrets(errMsg(e), deps.env)}`); }
  return 1;
}

/** Authors of the commits on an open PR that are not the bot's identity. */
export function foreignAuthors(authorLines: string, botIdentity: string): string[] {
  return [...new Set(authorLines.split("\n").map((l) => l.trim()).filter((l) => l && l !== botIdentity))];
}

export const AUTOMERGE_FAILURE_REASON =
  "auto-merge could not be enabled -- check the repository setting 'Allow auto-merge' and the branch protection requiring ci-status";

/** Posts the needs-human comment unless an identical one is already on the PR. */
function commentFailure(deps: Deps, repo: string, pr: string, checks: CheckResult[]): void {
  const { marker, body } = renderFailureComment(checks);
  const existing = deps.gh(["pr", "view", pr, "--repo", repo, "--json", "comments", "--jq", ".comments[].body"], true);
  if (!existing.includes(marker)) deps.gh(["pr", "comment", pr, "--repo", repo, "--body", maskSecrets(body, deps.env)]);
}

/** Creates/updates the bump branch and PR. Returns the process exit code. */
function publish(deps: Deps, opts: CliOptions, repo: string, plan: Plan): number {
  assertSafeBranch(plan.branch, opts.base);
  const name = deps.env.BOT_GIT_NAME ?? "qwenstudio-linux-bot";
  const email = deps.env.BOT_GIT_EMAIL ?? "noreply@github.com";
  const body = maskSecrets(plan.body, deps.env);

  // A maintainer who closed the bot's PR without merging has rejected this version: do not
  // recreate it every night. (Deleting the closed PR's branch does not change this; the
  // version is retried only when upstream moves on or the maintainer bumps by hand.)
  const rejected = deps.gh(["pr", "list", "--repo", repo, "--head", plan.branch, "--base", opts.base, "--state", "closed",
    "--json", "number,mergedAt", "--jq", ".[] | select(.mergedAt == null) | .number"]).trim().split("\n")[0];
  if (rejected) {
    deps.log(`version ${plan.feed.version}.${plan.feed.build} rejected by maintainer (PR #${rejected} closed without merging); not recreating`);
    return 0;
  }

  // Reuse the open PR for this branch if there is one. If a maintainer has already pushed
  // their own commits to it (e.g. a sidecars.json fix after a needs-human), a force-push from
  // base would destroy that work -- so leave the branch and PR alone and let CI/the human finish.
  let pr = deps.gh(["pr", "list", "--repo", repo, "--head", plan.branch, "--base", opts.base, "--state", "open", "--json", "number", "--jq", ".[0].number // empty"]).trim();
  if (pr) {
    const authors = deps.gh(["pr", "view", pr, "--repo", repo, "--json", "commits", "--jq", '.commits[].authors[] | "\\(.name) <\\(.email)>"']);
    const foreign = foreignAuthors(authors, `${name} <${email}>`);
    if (foreign.length) {
      deps.log(`PR #${pr} (${plan.branch}) has commits by ${foreign.join(", ")}; leaving the branch and PR untouched`);
      return 0;
    }
  }

  const dirty = deps.git(["status", "--porcelain", "--untracked-files=no"]).trim();
  if (dirty) throw new Error(`working tree has uncommitted changes; refusing to run:\n${dirty}`);

  // Authoritative comparison against the freshly fetched base (the pre-fetch one in main() is
  // only a cheap fast-path): if the base already carries this bump, there is nothing to do.
  deps.git(["fetch", "--quiet", "origin", `refs/heads/${opts.base}`]);
  const baseCurrent = validateUpstream(JSON.parse(deps.git(["show", "FETCH_HEAD:upstream.json"])));
  if (compareUpstream(plan.feed, baseCurrent) <= 0) {
    deps.log(`Up to date (feed ${plan.feed.version}.${plan.feed.build}, origin/${opts.base} ${baseCurrent.version}.${baseCurrent.build})`);
    return 0;
  }

  // Branch from the remote base explicitly (never from whatever HEAD happens to be), write the
  // bump, commit. Re-runs therefore always produce the same tree for the same feed + base.
  deps.git(["checkout", "-q", "-B", plan.branch, "FETCH_HEAD"]); // FETCH_HEAD: independent of the clone's refspec config
  const paths = deps.writeWorkspace({ manifest: plan.next, changelogLine: plan.changelogLine, pristineIndexJs: plan.pristineIndexJs });
  deps.git(["add", "--", ...paths]);
  deps.git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", plan.title]);

  // Idempotency: only push when the tree differs from what is already on the remote branch.
  // Pushing an identical tree under a new SHA would re-trigger CI, strip CI's needs-human label
  // and re-arm auto-merge every night for nothing.
  let unchanged = false;
  if (deps.git(["ls-remote", "--heads", "origin", plan.branch]).trim()) {
    deps.git(["fetch", "--quiet", "origin", plan.branch]);
    unchanged = deps.git(["rev-parse", "HEAD^{tree}"]).trim() === deps.git(["rev-parse", "FETCH_HEAD^{tree}"]).trim();
  }
  // Unchanged tree + open PR: no push, no body edit, no new comment -- but labels and auto-merge
  // are still reconciled below so a PR whose state drifted (e.g. auto-merge never armed) self-heals.
  const reconcileOnly = unchanged && Boolean(pr);
  if (unchanged) {
    deps.log(`${plan.branch}: unchanged on origin, nothing to push`);
  } else {
    deps.git(["push", "-f", "origin", `HEAD:refs/heads/${plan.branch}`]);
    deps.log(`pushed ${plan.branch}`);
  }

  if (reconcileOnly) {
    deps.log(`PR #${pr}: reconciling labels/auto-merge only`);
  } else if (pr) {
    deps.gh(["pr", "edit", pr, "--repo", repo, "--title", plan.title, "--body", body]);
    deps.log(`updated existing PR #${pr}`);
  } else {
    const url = deps.gh(["pr", "create", "--repo", repo, "--base", opts.base, "--head", plan.branch, "--title", plan.title, "--body", body]).trim();
    pr = url.split("/").pop() ?? "";
    if (!/^\d+$/.test(pr)) throw new Error(`could not determine the PR number from gh output: ${url}`);
    deps.log(`opened PR #${pr}`);
  }

  // Label edits tolerate failure: a label missing from the repo (or already absent from the PR)
  // must not abort the run. ci.yml's labeller recreates needs-human itself.
  const label = (add: string[], remove: string[]) => {
    for (const l of add) deps.gh(["pr", "edit", pr, "--repo", repo, "--add-label", l], true);
    for (const l of remove) deps.gh(["pr", "edit", pr, "--repo", repo, "--remove-label", l], true);
  };
  if (!reconcileOnly) label([LABEL_BUMP], []);

  if (!plan.decision.autoMerge) {
    deps.gh(["pr", "merge", pr, "--repo", repo, "--disable-auto"], true);
    label([LABEL_NEEDS_HUMAN], [LABEL_AUTOMERGE]);
    commentFailure(deps, repo, pr, plan.checks);
    deps.log(`PR #${pr}: pre-flight checks failed; labelled ${LABEL_NEEDS_HUMAN}, no auto-merge`);
    return 0;
  }

  // All checks passed: arm auto-merge FIRST; the automerge label only ever reflects a PR that
  // really has it. Re-enabling on a PR that already has it is rejected by GitHub, so skip then.
  const armed = deps.gh(["pr", "view", pr, "--repo", repo, "--json", "autoMergeRequest", "--jq", ".autoMergeRequest.enabledAt // empty"]).trim();
  if (armed && reconcileOnly) { deps.log(`PR #${pr}: auto-merge already enabled (${armed}); nothing to do`); return 0; }
  if (!armed) {
    try { deps.gh(["pr", "merge", pr, "--repo", repo, "--auto", "--squash"]); }
    catch (e) {
      const output = `${AUTOMERGE_FAILURE_REASON}\n${errMsg(e)}`;
      label([LABEL_NEEDS_HUMAN], [LABEL_AUTOMERGE]);
      commentFailure(deps, repo, pr, [...plan.checks, { name: "auto-merge enabled", ok: false, output }]);
      return reportFailure(deps, opts, repo, "auto-merge could not be enabled", `PR #${pr}\n${output}`, plan.feed);
    }
  }
  label([LABEL_AUTOMERGE], [LABEL_NEEDS_HUMAN]);
  deps.log(`PR #${pr}: all pre-flight checks passed; auto-merge ${armed ? `already enabled (${armed})` : "enabled"}`);
  return 0;
}

/** Returns the process exit code. Never calls process.exit. */
export async function main(argv = process.argv.slice(2), deps: Deps = realDeps()): Promise<number> {
  let opts: CliOptions;
  try { opts = parseArgs(argv); } catch (e) { deps.error(errMsg(e)); return 2; }
  const repo = deps.env.GITHUB_REPOSITORY ?? DEFAULT_REPO;

  let feed: FeedInfo;
  try {
    const text = opts.feedFile ? deps.readFile(opts.feedFile) : await deps.fetchText(opts.feedUrl);
    feed = parseFeed(text, opts.feedUrl);
  } catch (e) {
    return reportFailure(deps, opts, repo, "cannot read or parse the upstream feed", errMsg(e));
  }

  try {
    const current = deps.readUpstream();
    if (compareUpstream(feed, current) <= 0) {
      deps.log(`Up to date (feed ${feed.version}.${feed.build}, local ${current.version}.${current.build})`);
      return 0;
    }
    deps.log(`New upstream ${feed.version}.${feed.build} (local ${current.version}.${current.build}); running pre-flight checks`);

    const preflight = await deps.preflight(feed);
    for (const c of preflight.checks) deps.log(`  [${c.ok ? "x" : " "}] ${c.name}`);
    const plan = buildPlan({ feed, current, base: opts.base, preflight, fixtureChanged: fixtureDiffers(deps, preflight.pristineIndexJs) });

    if (opts.dryRun) { deps.log(renderDryRun(plan)); return 0; }
    return publish(deps, opts, repo, plan);
  } catch (e) {
    return reportFailure(deps, opts, repo, "unexpected error", e instanceof Error ? (e.stack ?? e.message) : String(e), feed);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
