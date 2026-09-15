import { readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, renameSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { readUpstream, readSidecars } from "./manifest.js";
import { deriveVersions, type DerivedVersions } from "./versions.js";
import { ROOT, BUILD_DIR, DIST_DIR, UNPACKED_DIR, CACHE_DIR } from "./paths.js";

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
  if (target === "deb") { cfg.deb.artifactName = v.artifacts.deb; cfg.deb.fpm = ["--version", v.upstreamLabel, "--iteration", v.rpmRelease]; }
  if (target === "rpm") { cfg.rpm.artifactName = v.artifacts.rpm; cfg.rpm.fpm = ["--version", v.rpmVersion, "--iteration", v.rpmRelease]; }
  if (target === "AppImage") { cfg.appImage.artifactName = v.artifacts.appImage; }
  return cfg;
}

export function packageTarget(target: Target, v: DerivedVersions): void {
  const dir = target.toLowerCase();
  const stage = path.join(BUILD_DIR, `stage-${dir}`);
  rmSync(stage, { recursive: true, force: true });
  cpSync(UNPACKED_DIR, stage, { recursive: true });
  const cfgPath = path.join(BUILD_DIR, `electron-builder.${dir}.json`);
  writeFileSync(cfgPath, JSON.stringify(buildConfig(target, v), null, 2) + "\n");
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
