import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compareUpstream, branchName, nextManifest, renderPrBody } from "../../scripts/upstream-check.js";
import { parseFeed } from "../../scripts/lib/manifest.js";

const feed = parseFeed(readFileSync("tests/fixtures/latest.yml", "utf8"), "https://download.qwen.ai/windows/x64/latest.yml");

describe("upstream-check", () => {
  it("compares semver first, then build", () => {
    expect(compareUpstream({ version: "1.0.3", build: 44 }, { version: "1.0.3", build: 44 })).toBe(0);
    expect(compareUpstream({ version: "1.0.3", build: 45 }, { version: "1.0.3", build: 44 })).toBe(1);
    expect(compareUpstream({ version: "1.0.4", build: 1 }, { version: "1.0.3", build: 99 })).toBe(1);
    expect(compareUpstream({ version: "1.0.3", build: 43 }, { version: "1.0.3", build: 44 })).toBe(-1);
  });
  it("builds the branch name", () => {
    expect(branchName("main", "1.0.3", 45)).toBe("upstream/main/v1.0.3.45");
    expect(branchName("qa/bump-sim", "1.0.3", 44)).toBe("upstream/qa/bump-sim/v1.0.3.44");
  });
  it("derives the next manifest with wrapper_revision 1", () => {
    expect(nextManifest(feed)).toEqual({
      version: "1.0.3", build: 44, wrapper_revision: 1,
      url: "https://download.qwen.ai/windows/x64/Qwen-1.0.3.44-release-win-x64.exe",
      sha512: feed.sha512, size: 124943360, releaseDate: "2025-08-15T03:38:13.875Z",
    });
  });
  it("renders a PR body with check results", () => {
    const body = renderPrBody({ feed, checks: [{ name: "patches apply", ok: true, output: "" }, { name: "electron version", ok: false, output: "36.0.0 != 35.1.4" }] });
    expect(body).toContain("- [x] patches apply");
    expect(body).toContain("- [ ] electron version");
    expect(body).toContain("36.0.0 != 35.1.4");
    expect(body).toContain("CI: pending");
    expect(body).toContain(feed.url);
  });
});

// ---------------------------------------------------------------------------------------------
// Decision logic and orchestration (fake deps: no git, gh, network or worktree writes)
// ---------------------------------------------------------------------------------------------
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decide, renderFailureComment, assertSafeBranch, parseArgs, buildPlan, main, checkPatches, foreignAuthors,
  CHECK_DOWNLOAD, CHECK_ELECTRON, CHECK_PATCHES, LABEL_AUTOMERGE, LABEL_BUMP, LABEL_NEEDS_HUMAN, DEFAULT_FEED,
  type Deps, type Preflight, type CheckResult,
} from "../../scripts/upstream-check.js";
import type { UpstreamManifest } from "../../scripts/lib/manifest.js";

const pass = (name: string): CheckResult => ({ name, ok: true, output: "" });
const fail = (name: string, output: string): CheckResult => ({ name, ok: false, output });

const current44: UpstreamManifest = {
  version: "1.0.3", build: 44, wrapper_revision: 1,
  url: "https://download.qwen.ai/windows/x64/Qwen-1.0.3.44-release-win-x64.exe",
  sha512: feed.sha512, size: 124954112, releaseDate: "2025-08-15T03:38:13.875Z",
};
const current43: UpstreamManifest = { ...current44, build: 43, url: current44.url.replace(".44-", ".43-") };
const feedText = readFileSync("tests/fixtures/latest.yml", "utf8");

interface Fake { deps: Deps; git: string[][]; gh: string[][]; writes: unknown[]; logs: string[]; errors: string[] }

function fakeDeps(o: {
  current?: UpstreamManifest; feedText?: string; fetchError?: string; preflight?: Preflight;
  prNumber?: string; comments?: string; authors?: string; autoMergeEnabledAt?: string; env?: NodeJS.ProcessEnv; files?: Record<string, string>; dirty?: string;
} = {}): Fake {
  const git: string[][] = []; const gh: string[][] = []; const writes: unknown[] = []; const logs: string[] = []; const errors: string[] = [];
  const preflight: Preflight = o.preflight ?? { checks: [pass(CHECK_DOWNLOAD), pass(CHECK_ELECTRON), pass(CHECK_PATCHES)], installerSize: 124954112, electronDetected: "35.1.4" };
  const deps: Deps = {
    async fetchText(url) { if (o.fetchError) throw new Error(o.fetchError); expect(url).toBe(DEFAULT_FEED); return o.feedText ?? feedText; },
    readFile: (p) => { const f = o.files?.[p]; if (f === undefined) throw new Error(`ENOENT ${p}`); return f; },
    readUpstream: () => o.current ?? current44,
    preflight: async () => preflight,
    writeWorkspace: (w) => { writes.push(w); return ["upstream.json", "CHANGELOG.md", ...(w.pristineIndexJs ? ["tests/fixtures/app-pristine/out/main/index.js"] : [])]; },
    git: (args) => {
      git.push(args);
      if (args[0] === "status") return o.dirty ?? "";
      if (args[0] === "diff") return "upstream.json\n";
      return "";
    },
    gh: (args) => {
      gh.push(args);
      if (args[0] === "pr" && args[1] === "list") return o.prNumber ?? "";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/sams-git-195/qwenstudio-linux/pull/77\n";
      if (args[0] === "pr" && args[1] === "view" && args.includes("autoMergeRequest")) return o.autoMergeEnabledAt ?? "";
      if (args[0] === "pr" && args[1] === "view" && args.includes("commits")) return o.authors ?? "qwenstudio-linux-bot <noreply@github.com>\n";
      if (args[0] === "pr" && args[1] === "view") return o.comments ?? "";
      if (args[0] === "issue" && args[1] === "list") return "";
      return "";
    },
    log: (m) => logs.push(m), error: (m) => errors.push(m),
    env: o.env ?? {},
  };
  return { deps, git, gh, writes, logs, errors };
}

const ghCalls = (f: Fake, ...prefix: string[]) => f.gh.filter((a) => prefix.every((p, i) => a[i] === p));

describe("upstream-check decision logic", () => {
  it("auto-merges only when every check passed", () => {
    expect(decide([pass("a"), pass("b")])).toEqual({ autoMerge: true, addLabels: [LABEL_BUMP, LABEL_AUTOMERGE], removeLabels: [LABEL_NEEDS_HUMAN] });
    expect(decide([pass("a"), fail("b", "boom")])).toEqual({ autoMerge: false, addLabels: [LABEL_BUMP, LABEL_NEEDS_HUMAN], removeLabels: [LABEL_AUTOMERGE] });
    expect(decide([fail("a", "skipped")]).autoMerge).toBe(false);
  });
  it("never auto-merges an empty check list", () => {
    expect(decide([]).autoMerge).toBe(false);
    expect(decide([]).addLabels).toContain(LABEL_NEEDS_HUMAN);
  });
  it("renders a failure comment with a stable marker per failure set", () => {
    const a = renderFailureComment([pass("ok"), fail(CHECK_ELECTRON, "36.0.0 != 35.1.4")]);
    const b = renderFailureComment([pass("ok"), fail(CHECK_ELECTRON, "36.0.0 != 35.1.4")]);
    const c = renderFailureComment([fail(CHECK_ELECTRON, "37.0.0 != 35.1.4")]);
    expect(a.marker).toBe(b.marker);
    expect(a.marker).not.toBe(c.marker);
    expect(a.body.startsWith(a.marker)).toBe(true);
    expect(a.body).toContain(`**${CHECK_ELECTRON}**`);
    expect(a.body).toContain("36.0.0 != 35.1.4");
    expect(a.body).not.toContain("**ok**");
  });
  it("refuses to push anything but upstream/* branches", () => {
    expect(() => assertSafeBranch("upstream/main/v1.0.3.45", "main")).not.toThrow();
    expect(() => assertSafeBranch("main", "main")).toThrow(/refusing/);
    expect(() => assertSafeBranch("upstream/x", "upstream/x")).toThrow(/refusing/);
    expect(() => assertSafeBranch("feature/foo", "main")).toThrow(/refusing/);
  });
  it("parses CLI arguments", () => {
    expect(parseArgs([])).toEqual({ feedUrl: DEFAULT_FEED, base: "main", dryRun: false });
    expect(parseArgs(["--feed-url", "https://x/latest.yml", "--base-branch", "qa/bump-sim", "--dry-run", "--feed-file", "f.yml"]))
      .toEqual({ feedUrl: "https://x/latest.yml", feedFile: "f.yml", base: "qa/bump-sim", dryRun: true });
    expect(() => parseArgs(["--bogus"])).toThrow(/usage/);
    expect(() => parseArgs(["--feed-url"])).toThrow(/usage/);
    expect(() => parseArgs(["--feed-url", "--dry-run"])).toThrow(/usage/);
  });
  it("builds a plan that uses the actual installer size and the branch/title conventions", () => {
    const plan = buildPlan({ feed, current: current43, base: "main", fixtureChanged: true,
      preflight: { checks: [pass(CHECK_DOWNLOAD), fail(CHECK_ELECTRON, "36.0.0 != 35.1.4")], installerSize: 124954112, electronDetected: "36.0.0" } });
    expect(plan.next).toEqual({ ...current44, size: 124954112 });
    expect(plan.branch).toBe("upstream/main/v1.0.3.44");
    expect(plan.title).toBe("chore(upstream): bump Qwen Studio to 1.0.3.44");
    expect(plan.changelogLine).toBe("Upstream bump to 1.0.3.44 (released 2025-08-15T03:38:13.875Z)");
    expect(plan.decision.autoMerge).toBe(false);
    expect(plan.body).toContain("Electron embedded in Qwen.exe: 36.0.0");
    expect(plan.body).toContain("- [ ] " + CHECK_ELECTRON);
  });
  it("keeps the feed size when the download failed", () => {
    const plan = buildPlan({ feed, current: current43, base: "main", fixtureChanged: false, preflight: { checks: [fail(CHECK_DOWNLOAD, "HTTP 404")] } });
    expect(plan.next.size).toBe(124943360);
  });
});

describe("upstream-check orchestration", () => {
  it("exits 0 with 'Up to date' and touches nothing when the feed is not newer", async () => {
    const f = fakeDeps({ current: current44 });
    expect(await main([], f.deps)).toBe(0);
    expect(f.logs.join("\n")).toContain("Up to date (feed 1.0.3.44, local 1.0.3.44)");
    expect(f.git).toEqual([]); expect(f.gh).toEqual([]); expect(f.writes).toEqual([]);
  });
  it("treats an older feed as up to date too", async () => {
    const f = fakeDeps({ current: { ...current44, version: "1.0.4", build: 0, url: current44.url.replace("1.0.3.44", "1.0.4.0") } });
    expect(await main([], f.deps)).toBe(0);
    expect(f.logs.join("\n")).toContain("Up to date");
    expect(f.git).toEqual([]); expect(f.gh).toEqual([]);
  });
  it("dry-run runs the checks and prints the plan without any git/gh/worktree writes", async () => {
    const f = fakeDeps({ current: current43 });
    expect(await main(["--dry-run"], f.deps)).toBe(0);
    const out = f.logs.join("\n");
    expect(out).toContain("New upstream 1.0.3.44 (local 1.0.3.43)");
    expect(out).toContain("[dry-run]");
    expect(out).toContain("branch:      upstream/main/v1.0.3.44");
    expect(out).toContain("PR title:    chore(upstream): bump Qwen Studio to 1.0.3.44");
    expect(out).toContain("auto-merge:  true");
    expect(out).toContain(`labels:      ${LABEL_BUMP}, ${LABEL_AUTOMERGE}`);
    expect(out).toContain('"size": 124954112');
    expect(out).toContain("CI: pending");
    expect(f.git).toEqual([]); expect(f.gh).toEqual([]); expect(f.writes).toEqual([]);
  });
  it("all checks pass: branch, commit, force-push, PR create, upstream-bump + automerge, auto-merge enabled", async () => {
    const f = fakeDeps({ current: current43, preflight: { checks: [pass(CHECK_DOWNLOAD), pass(CHECK_ELECTRON), pass(CHECK_PATCHES)], installerSize: 124954112, electronDetected: "35.1.4", pristineIndexJs: "/x/index.js" }, files: { "/x/index.js": "new" } });
    expect(await main(["--base-branch", "main"], f.deps)).toBe(0);
    expect(f.git.map((a) => a[0] === "-c" ? a[4] : a[0])).toEqual(["status", "checkout", "add", "diff", "commit", "push"]);
    expect(f.git.find((a) => a[0] === "checkout")).toEqual(["checkout", "-B", "upstream/main/v1.0.3.44"]);
    expect(f.git.find((a) => a[0] === "push")).toEqual(["push", "-f", "origin", "HEAD:refs/heads/upstream/main/v1.0.3.44"]);
    const commit = f.git.find((a) => a.includes("commit"))!;
    expect(commit).toContain("user.name=qwenstudio-linux-bot");
    expect(commit).toContain("user.email=noreply@github.com");
    expect(commit[commit.length - 1]).toBe("chore(upstream): bump Qwen Studio to 1.0.3.44");
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ manifest: { build: 44, size: 124954112, wrapper_revision: 1 }, pristineIndexJs: "/x/index.js" });
    expect(ghCalls(f, "pr", "create")).toHaveLength(1);
    expect(ghCalls(f, "pr", "create")[0]).toContain("--head"); expect(ghCalls(f, "pr", "create")[0]).toContain("upstream/main/v1.0.3.44");
    expect(ghCalls(f, "pr", "edit").filter((a) => a.includes("--add-label")).map((a) => a[a.length - 1])).toEqual([LABEL_BUMP, LABEL_AUTOMERGE]);
    expect(ghCalls(f, "pr", "edit").filter((a) => a.includes("--remove-label")).map((a) => a[a.length - 1])).toEqual([LABEL_NEEDS_HUMAN]);
    expect(ghCalls(f, "pr", "merge")).toEqual([["pr", "merge", "77", "--repo", "sams-git-195/qwenstudio-linux", "--auto", "--squash"]]);
    expect(ghCalls(f, "pr", "comment")).toEqual([]);
    expect(ghCalls(f, "issue")).toEqual([]);
  });
  it("a failed check: needs-human, no automerge label, no auto-merge, one failure comment", async () => {
    const f = fakeDeps({ current: current43, preflight: { checks: [pass(CHECK_DOWNLOAD), fail(CHECK_ELECTRON, "Qwen.exe embeds Electron 36.0.0 but sidecars.json pins 35.1.4"), pass(CHECK_PATCHES)], installerSize: 1, electronDetected: "36.0.0" }, env: { GITHUB_REPOSITORY: "o/r" } });
    expect(await main([], f.deps)).toBe(0);
    expect(f.writes).toHaveLength(1);
    expect((f.writes[0] as { manifest: UpstreamManifest }).manifest.build).toBe(44);
    expect(ghCalls(f, "pr", "edit").filter((a) => a.includes("--add-label")).map((a) => a[a.length - 1])).toEqual([LABEL_BUMP, LABEL_NEEDS_HUMAN]);
    expect(ghCalls(f, "pr", "edit").filter((a) => a.includes("--remove-label")).map((a) => a[a.length - 1])).toEqual([LABEL_AUTOMERGE]);
    expect(ghCalls(f, "pr", "merge").map((a) => a.slice(-1)[0])).toEqual(["--disable-auto"]);
    const comments = ghCalls(f, "pr", "comment");
    expect(comments).toHaveLength(1);
    expect(comments[0][comments[0].length - 1]).toContain("36.0.0 but sidecars.json pins 35.1.4");
    expect(comments[0]).toContain("o/r");
    expect(f.gh.every((a) => a[a.indexOf("--repo") + 1] === "o/r")).toBe(true);
    expect(ghCalls(f, "issue")).toEqual([]);
  });
  it("does not repeat the failure comment when the same failure is already commented", async () => {
    const checks = [fail(CHECK_DOWNLOAD, "HTTP 404"), fail(CHECK_ELECTRON, "skipped: a previous check failed")];
    const { marker } = renderFailureComment(checks);
    const f = fakeDeps({ current: current43, preflight: { checks }, prNumber: "12", comments: `hello\n${marker}\nold body` });
    expect(await main([], f.deps)).toBe(0);
    expect(ghCalls(f, "pr", "comment")).toEqual([]);
    expect(f.writes[0]).toMatchObject({ manifest: { size: 124943360 }, pristineIndexJs: undefined });
  });
  it("reuses an open PR from the bump branch instead of opening a second one", async () => {
    const f = fakeDeps({ current: current43, prNumber: "12\n" });
    expect(await main([], f.deps)).toBe(0);
    expect(ghCalls(f, "pr", "create")).toEqual([]);
    const edit = ghCalls(f, "pr", "edit").find((a) => a.includes("--title"))!;
    expect(edit.slice(0, 3)).toEqual(["pr", "edit", "12"]);
    expect(edit).toContain("chore(upstream): bump Qwen Studio to 1.0.3.44");
    expect(ghCalls(f, "pr", "merge")[0].slice(0, 3)).toEqual(["pr", "merge", "12"]);
    expect(f.git.find((a) => a[0] === "push")).toEqual(["push", "-f", "origin", "HEAD:refs/heads/upstream/main/v1.0.3.44"]);
  });
  it("does not re-enable auto-merge on a PR that already has it armed", async () => {
    const f = fakeDeps({ current: current43, prNumber: "12", autoMergeEnabledAt: "2026-09-15T04:20:00Z" });
    expect(await main([], f.deps)).toBe(0);
    expect(ghCalls(f, "pr", "merge")).toEqual([]);
    expect(f.git.find((a) => a[0] === "push")).toBeDefined();
    expect(f.logs.join("\n")).toContain("auto-merge already enabled");
  });
  it("leaves an existing PR alone when a human has pushed commits to the bump branch", async () => {
    const f = fakeDeps({ current: current43, prNumber: "12", authors: "qwenstudio-linux-bot <noreply@github.com>\nSam <sam@example.com>\nqwenstudio-linux-bot <noreply@github.com>\n" });
    expect(await main([], f.deps)).toBe(0);
    expect(f.git).toEqual([]); expect(f.writes).toEqual([]);
    expect(f.gh.map((a) => a.slice(0, 2))).toEqual([["pr", "list"], ["pr", "view"]]);
    expect(f.logs.join("\n")).toContain("PR #12 (upstream/main/v1.0.3.44) has commits by Sam <sam@example.com>; leaving the branch and PR untouched");
  });
  it("foreignAuthors ignores the bot identity and blank lines", () => {
    expect(foreignAuthors("bot <b@x>\n\nA <a@x>\nbot <b@x>\nA <a@x>\n", "bot <b@x>")).toEqual(["A <a@x>"]);
    expect(foreignAuthors("", "bot <b@x>")).toEqual([]);
  });
  it("uses the base branch in the branch name and PR base", async () => {
    const f = fakeDeps({ current: current43 });
    expect(await main(["--base-branch", "qa/bump-sim"], f.deps)).toBe(0);
    expect(f.git.find((a) => a[0] === "checkout")).toEqual(["checkout", "-B", "upstream/qa/bump-sim/v1.0.3.44"]);
    const create = ghCalls(f, "pr", "create")[0];
    expect(create[create.indexOf("--base") + 1]).toBe("qa/bump-sim");
    expect(create[create.indexOf("--head") + 1]).toBe("upstream/qa/bump-sim/v1.0.3.44");
  });
  it("honours BOT_GIT_NAME/BOT_GIT_EMAIL", async () => {
    const f = fakeDeps({ current: current43, env: { BOT_GIT_NAME: "github-actions[bot]", BOT_GIT_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com" } });
    expect(await main([], f.deps)).toBe(0);
    const commit = f.git.find((a) => a.includes("commit"))!;
    expect(commit).toContain("user.name=github-actions[bot]");
    expect(commit).toContain("user.email=41898282+github-actions[bot]@users.noreply.github.com");
  });
  it("refuses to mutate a dirty working tree and reports it as a bot failure without pushing", async () => {
    const f = fakeDeps({ current: current43, dirty: " M scripts/foo.ts" });
    expect(await main([], f.deps)).toBe(1);
    expect(f.git.map((a) => a[0])).toEqual(["status"]);
    expect(f.writes).toEqual([]);
    expect(ghCalls(f, "pr").map((a) => a[1])).toEqual(["list"]);
    expect(ghCalls(f, "issue", "create")).toHaveLength(1);
    expect(f.errors.join("\n")).toContain("uncommitted changes");
  });
  it("feed fetch/parse failure opens one needs-human issue (or comments on the existing one) and exits 1", async () => {
    const f = fakeDeps({ fetchError: "HTTP 503 for feed" });
    expect(await main([], f.deps)).toBe(1);
    const create = ghCalls(f, "issue", "create");
    expect(create).toHaveLength(1);
    expect(create[0]).toContain("Upstream bot failure: cannot read or parse the upstream feed");
    expect(create[0]).toContain(LABEL_NEEDS_HUMAN);
    expect(create[0][create[0].length - 1]).toContain("HTTP 503 for feed");
    expect(ghCalls(f, "pr")).toEqual([]); expect(f.git).toEqual([]);

    const g = fakeDeps({ feedText: readFileSync("tests/fixtures/latest-bad-filename.yml", "utf8") });
    g.deps.gh = (args) => { g.gh.push(args); return args[1] === "list" ? "5\n" : ""; };
    expect(await main([], g.deps)).toBe(1);
    expect(ghCalls(g, "issue", "create")).toEqual([]);
    expect(ghCalls(g, "issue", "comment")[0].slice(0, 3)).toEqual(["issue", "comment", "5"]);
  });
  it("dry-run never opens an issue on failure", async () => {
    const f = fakeDeps({ fetchError: "boom" });
    expect(await main(["--dry-run"], f.deps)).toBe(1);
    expect(f.gh).toEqual([]);
    expect(f.errors.join("\n")).toContain("boom");
  });
  it("--feed-file reads the feed from disk, resolving the installer against --feed-url", async () => {
    const f = fakeDeps({ current: current44, files: { "/fx/latest.yml": feedText.replace(/1\.0\.3\.44/g, "1.0.3.45") } });
    f.deps.fetchText = async () => { throw new Error("must not fetch"); };
    expect(await main(["--feed-file", "/fx/latest.yml", "--dry-run"], f.deps)).toBe(0);
    const out = f.logs.join("\n");
    expect(out).toContain("New upstream 1.0.3.45 (local 1.0.3.44)");
    expect(out).toContain("https://download.qwen.ai/windows/x64/Qwen-1.0.3.45-release-win-x64.exe");
  });
  it("returns 2 on bad CLI arguments without side effects", async () => {
    const f = fakeDeps();
    expect(await main(["--nope"], f.deps)).toBe(2);
    expect(f.gh).toEqual([]); expect(f.git).toEqual([]);
  });
});

describe("checkPatches", () => {
  it("passes against the committed pristine fixture and fails against a tampered copy", () => {
    const pristine = path.resolve("tests/fixtures/app-pristine");
    const ok = checkPatches(pristine);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("0001-linux-platform-dir.patch: applies cleanly");

    const tampered = mkdtempSync(path.join(os.tmpdir(), "qs-tampered-"));
    writeFileSync(path.join(tampered, "index.js"), "// nothing the patches expect\n");
    const bad = checkPatches(tampered);
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("FAILED");
  });
});
