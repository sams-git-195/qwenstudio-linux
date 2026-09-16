import { readdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, rmSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { run } from "./lib/exec.js";
import { readUpstream } from "./lib/manifest.js";
import { deriveVersions } from "./lib/versions.js";
import { APP_DIR, APP_PRISTINE_DIR, BUILD_DIR, PATCHES_DIR, ROOT } from "./lib/paths.js";

const GENERATED = ["package.json", "out/main/linux-update.js"]; // produced by the stage, never part of a patch

export function listPatches(): string[] {
  return readdirSync(PATCHES_DIR).filter((f) => /^\d{4}-.+\.patch$/.test(f)).sort();
}

// GIT_CEILING_DIRECTORIES stops git's upward search for a repository at cwd's parent, so it
// never discovers an enclosing repo (e.g. this project's own .git when cwd is build/app, which
// has no .git of its own). Without it, `git apply` scopes paths to the discovered repo's root
// and silently skips (exit 0, no changes) any patch whose paths don't fall under cwd's prefix
// relative to that root -- setting the ceiling to cwd itself is not enough, since git still
// ascends past cwd once before consulting the ceiling list.
export function gitApply(patchFile: string, cwd: string, check: boolean): void {
  run("git", ["apply", ...(check ? ["--check"] : []), "--whitespace=nowarn", patchFile], {
    cwd, capture: true, env: { GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
  });
}

/** Applies all patches to appDir. Verifies first on a scratch copy of pristineDir; exits 2 on any failure. */
export function applyPatches(appDir = APP_DIR, pristineDir = APP_PRISTINE_DIR): string[] {
  const patches = listPatches();
  const appVersion = deriveVersions(readUpstream()).appVersion;
  const scratch = mkdtempSync(path.join(os.tmpdir(), "qs-patch-check-"));
  cpSync(pristineDir, scratch, { recursive: true });
  for (const p of patches) {
    const abs = path.join(PATCHES_DIR, p);
    try { gitApply(abs, scratch, true); gitApply(abs, scratch, false); }
    catch (e) { console.error(`Patch ${p} does not apply to upstream ${appVersion}\n${(e as Error).message}`); process.exit(2); }
  }
  rmSync(scratch, { recursive: true, force: true });
  for (const p of patches) gitApply(path.join(PATCHES_DIR, p), appDir, false);
  return patches;
}

export function finishPatchStage(appDir = APP_DIR): void {
  copyFileSync(path.join(ROOT, "src/app/linux-update.js"), path.join(appDir, "out/main/linux-update.js"));
  const pkgPath = path.join(appDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  pkg.version = deriveVersions(readUpstream()).appVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const applied = listPatches().map((p) => ({
    name: p, sha256: createHash("sha256").update(readFileSync(path.join(PATCHES_DIR, p))).digest("hex"),
  }));
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(path.join(BUILD_DIR, "patch.json"), JSON.stringify({ appVersion: pkg.version, patches: applied }, null, 2) + "\n");
}

/** Regenerates patches/NNNN-*.patch from the diff between (pristine + lower-numbered patches) and build/app. */
export function exportPatch(number: string): void {
  const target = listPatches().find((p) => p.startsWith(`${number}-`));
  if (!target) { console.error(`No patch file numbered ${number} exists in patches/`); process.exit(1); }
  if (!existsSync(APP_DIR) || !existsSync(APP_PRISTINE_DIR)) { console.error("Run `npm run patches:dev` first"); process.exit(1); }
  const repo = mkdtempSync(path.join(os.tmpdir(), "qs-patch-export-"));
  cpSync(APP_PRISTINE_DIR, repo, { recursive: true });
  const git = (args: string[]) => run("git", args, { cwd: repo, capture: true, env: { GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });
  git(["init", "-q"]); git(["add", "-A"]); git(["commit", "-q", "-m", "pristine"]);
  for (const p of listPatches()) {
    if (p >= target) break;
    gitApply(path.join(PATCHES_DIR, p), repo, false); git(["add", "-A"]); git(["commit", "-q", "-m", p]);
  }
  cpSync(APP_DIR, repo, { recursive: true, filter: (src) => !GENERATED.some((g) => src.endsWith(path.sep + g.replace(/\//g, path.sep))) && !src.includes(`${path.sep}.git`) });
  const diff = git(["diff", "--src-prefix=a/", "--dst-prefix=b/", "--", ".", ...GENERATED.map((g) => `:!${g}`)]);
  if (!diff.trim()) { console.error(`Export of ${target} produced an empty diff`); process.exit(1); }
  writeFileSync(path.join(PATCHES_DIR, target), diff.endsWith("\n") ? diff : diff + "\n");
  rmSync(repo, { recursive: true, force: true });
  console.log(`wrote patches/${target}`);
}

export function main(argv = process.argv.slice(2)): void {
  const i = argv.indexOf("--export");
  if (i !== -1) { exportPatch(argv[i + 1]); return; }
  const applied = applyPatches();
  finishPatchStage();
  console.log(`applied ${applied.length} patch(es): ${applied.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
