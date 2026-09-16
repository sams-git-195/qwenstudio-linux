import { readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, renameSync, existsSync, readdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { readUpstream, readSidecars } from "./manifest.js";
import { deriveVersions, type DerivedVersions } from "./versions.js";
import { ROOT, BUILD_DIR, DIST_DIR, UNPACKED_DIR, CACHE_DIR } from "./paths.js";

// A real Debian changelog is required for the deb target: lintian's
// debian-changelog-file-missing-or-wrong-name / syntax-error-in-debian-changelog
// checks reject fpm's own auto-generated placeholder (spec section 11.3). The
// content is version-derived, so it is generated at package time (packageTarget),
// not inside the pure buildConfig() that tests/unit/electron-builder-config.test.ts
// exercises without touching the filesystem.
//
// The date is SOURCE_DATE_EPOCH (seconds since epoch, https://reproducible-builds.org/specs/source-date-epoch/)
// when set, else upstream.json's releaseDate, rather than the build's wall-clock time -- so two
// builds of the same upstream release produce byte-identical changelog text.
function debianChangelogDate(): string {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  const date = sourceDateEpoch ? new Date(Number(sourceDateEpoch) * 1000) : new Date(readUpstream(ROOT).releaseDate);
  return date.toUTCString().replace(/GMT$/, "+0000");
}

function debianChangelogText(v: DerivedVersions): string {
  return (
    `qwen-studio (${v.debVersion}) unstable; urgency=medium\n\n` +
    `  * Unofficial Linux packaging of upstream Qwen Studio ${v.upstreamLabel}.\n` +
    `  * See https://github.com/sams-git-195/qwenstudio-linux/releases for\n` +
    `    the full release history.\n\n` +
    ` -- sams-git-195 <samheard95@gmail.com>  ${debianChangelogDate()}\n`
  );
}

// lintian's shared-library-is-executable flags Electron's bundled .so files, which carry the
// executable bit as shipped in Electron's own official zip (assemble.ts preserves upstream file
// modes verbatim, spec §10.4). Per controller ruling in task B5 fix round 1, this is fixed here
// rather than suppressed: the exec bit is not needed for the dynamic loader to mmap/dlopen a
// shared object (only the executable bit on the actual ELF *executable*, e.g. qwen-studio itself,
// matters for that), so it is stripped in the per-target packaging stage copy only -- the shared
// build/linux-unpacked/ output that assemble.ts produces (and that AppImage packages directly)
// stays byte-for-byte verbatim.
function stripExecFromSharedLibs(dir: string): void {
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (/\.so(\.\d+)*$/.test(entry)) {
      chmodSync(path.join(dir, entry), 0o644);
    }
  }
}

export type Target = "AppImage" | "deb" | "rpm";
export const TARGETS: Target[] = ["AppImage", "deb", "rpm"];
export const HOMEPAGE = "https://github.com/sams-git-195/qwenstudio-linux";

export function buildConfig(target: Target, v: DerivedVersions): Record<string, unknown> {
  const base = JSON.parse(readFileSync(path.join(ROOT, "packaging", "electron-builder.base.json"), "utf8"));
  const cfg = structuredClone(base) as Record<string, any>;
  const dir = target.toLowerCase();
  // electronVersion is intentionally not baked into the base config file; it is
  // injected here from sidecars.json so that file stays the single source of
  // truth for the bundled Electron version (spec §6.2).
  cfg.electronVersion = readSidecars(ROOT).electron.version;
  cfg.extraMetadata = { name: "qwen-studio", version: v.appVersion, description: cfg.linux.description, homepage: HOMEPAGE };
  cfg.linux.target = [target];
  cfg.directories.output = `dist/${dir}`;
  if (target === "deb") { cfg.deb.artifactName = v.artifacts.deb; cfg.deb.fpm = [...(cfg.deb.fpm ?? []), "--version", v.upstreamLabel, "--iteration", v.rpmRelease]; }
  if (target === "rpm") { cfg.rpm.artifactName = v.artifacts.rpm; cfg.rpm.fpm = [...(cfg.rpm.fpm ?? []), "--version", v.rpmVersion, "--iteration", v.rpmRelease]; }
  if (target === "AppImage") { cfg.appImage.artifactName = v.artifacts.appImage; }
  return cfg;
}

export function packageTarget(target: Target, v: DerivedVersions): void {
  const dir = target.toLowerCase();
  const stage = path.join(BUILD_DIR, `stage-${dir}`);
  rmSync(stage, { recursive: true, force: true });
  cpSync(UNPACKED_DIR, stage, { recursive: true });
  stripExecFromSharedLibs(stage);
  const cfgPath = path.join(BUILD_DIR, `electron-builder.${dir}.json`);
  const cfg = buildConfig(target, v) as Record<string, any>;
  if (target === "deb") {
    const changelogPath = path.join(BUILD_DIR, "packaging", "deb-changelog");
    mkdirSync(path.dirname(changelogPath), { recursive: true });
    writeFileSync(changelogPath, debianChangelogText(v));
    // fpm (via the -s dir source type) requires every "--flag value" pair to
    // precede all bare "source=dest" positional mappings on the command line;
    // once a positional appears, fpm's arg parser treats everything after it
    // as more positionals (including any later "--flag" tokens), so the
    // copyright mapping (the only positional we add) MUST be last.
    // Both flags point at the same file: fpm always writes the Debian changelog
    // to usr/share/doc/<name>/changelog.Debian.gz, but silently renames it to
    // changelog.gz (the "upstream changelog" name) unless an upstream changelog
    // is also supplied (see fpm's lib/fpm/package/deb.rb). Supplying one here
    // (reusing the same well-formed content) keeps changelog.Debian.gz in place.
    const copyrightMapping = `${path.join(ROOT, "packaging", "deb", "copyright")}=/usr/share/doc/qwen-studio/copyright`;
    cfg.deb.fpm = [...cfg.deb.fpm, "--deb-changelog", changelogPath, "--deb-upstream-changelog", changelogPath, copyrightMapping];
  }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  const outDir = path.join(DIST_DIR, dir);
  rmSync(outDir, { recursive: true, force: true });
  run("npx", ["electron-builder", "--linux", target, "--x64", "--config", cfgPath, "--prepackaged", stage, "--publish", "never"], {
    cwd: ROOT, env: { ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? path.join(CACHE_DIR, "electron-builder"), CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  });
  const artifact = target === "deb" ? v.artifacts.deb : target === "rpm" ? v.artifacts.rpm : v.artifacts.appImage;
  if (!existsSync(path.join(outDir, artifact))) throw new Error(`electron-builder did not produce ${artifact}; contents: ${readdirSync(outDir).join(", ")}`);
  mkdirSync(DIST_DIR, { recursive: true });
  renameSync(path.join(outDir, artifact), path.join(DIST_DIR, artifact));
  if (target === "AppImage") renameSync(path.join(outDir, "latest-linux.yml"), path.join(DIST_DIR, "latest-linux.yml"));
  rmSync(outDir, { recursive: true, force: true });
}

export async function packageAll(): Promise<void> {
  const v = deriveVersions(readUpstream());
  rmSync(DIST_DIR, { recursive: true, force: true });
  for (const t of TARGETS) { console.log(`-- packaging ${t}`); packageTarget(t, v); }
  console.log(`dist/: ${readdirSync(DIST_DIR).sort().join(", ")}`);
}
