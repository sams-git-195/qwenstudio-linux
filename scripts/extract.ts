import { readFileSync, rmSync, mkdirSync, cpSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as asar from "@electron/asar";
import { readUpstream, readSidecars } from "./lib/manifest.js";
import { run } from "./lib/exec.js";
import {
  BUILD_DIR, NSIS_DIR, WIN_APP_DIR, APP_PRISTINE_DIR, APP_DIR, ELECTRON_DIR, BUN_DIR, UV_DIR, LICENSES_DIR,
} from "./lib/paths.js";
import type { FetchResult } from "./fetch.js";

export function detectElectronVersion(exePath: string): string {
  const text = readFileSync(exePath).toString("latin1");
  const m = /Electron\/(\d+\.\d+\.\d+)/.exec(text);
  if (!m) throw new Error(`Electron version marker not found in ${exePath}`);
  return m[1];
}

function fresh(dir: string): void { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }

function assertExtracted(dir: string, mapping: Record<string, string>, label: string): void {
  for (const [name, rel] of Object.entries(mapping)) {
    if (!existsSync(path.join(dir, rel))) { console.error(`${label}: expected "${rel}" (for ${name}) inside the archive`); process.exit(4); }
  }
}

export async function extractAll(): Promise<void> {
  const fetched = JSON.parse(readFileSync(path.join(BUILD_DIR, "fetch.json"), "utf8")) as FetchResult;
  const up = readUpstream(); const sc = readSidecars();

  fresh(NSIS_DIR);
  run("7z", ["x", "-y", `-o${NSIS_DIR}`, fetched.installer, "$PLUGINSDIR/app-64.7z"]);
  fresh(WIN_APP_DIR);
  run("7z", ["x", "-y", `-o${WIN_APP_DIR}`, path.join(NSIS_DIR, "$PLUGINSDIR", "app-64.7z")]);

  fresh(APP_PRISTINE_DIR);
  asar.extractAll(path.join(WIN_APP_DIR, "resources", "app.asar"), APP_PRISTINE_DIR);
  rmSync(APP_DIR, { recursive: true, force: true });
  cpSync(APP_PRISTINE_DIR, APP_DIR, { recursive: true });

  const pkg = JSON.parse(readFileSync(path.join(APP_PRISTINE_DIR, "package.json"), "utf8")) as { name: string; version: string };
  if (pkg.name !== "Qwen") { console.error(`app.asar package.json name is "${pkg.name}", expected "Qwen"`); process.exit(4); }
  if (pkg.version !== up.version) { console.error(`app.asar version ${pkg.version} != upstream.json version ${up.version}`); process.exit(4); }
  const electronDetected = detectElectronVersion(path.join(WIN_APP_DIR, "Qwen.exe"));
  if (electronDetected !== sc.electron.version) {
    console.error(`Electron version mismatch: Qwen.exe embeds ${electronDetected}, sidecars.json pins ${sc.electron.version}`); process.exit(4);
  }

  fresh(ELECTRON_DIR); run("unzip", ["-q", "-o", fetched.electron, "-d", ELECTRON_DIR]);
  fresh(BUN_DIR); run("unzip", ["-q", "-o", fetched.bun, "-d", BUN_DIR]);
  assertExtracted(BUN_DIR, sc.bun.extract ?? {}, "bun");
  fresh(UV_DIR); run("tar", ["xzf", fetched.uv, "-C", UV_DIR]);
  assertExtracted(UV_DIR, sc.uv.extract ?? {}, "uv");

  fresh(LICENSES_DIR);
  for (const f of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) copyFileSync(path.join(WIN_APP_DIR, f), path.join(LICENSES_DIR, f));
  console.log(`extracted upstream ${up.version}.${up.build} (Electron ${electronDetected})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) extractAll();
