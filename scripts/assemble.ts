import { rmSync, mkdirSync, cpSync, renameSync, chmodSync, existsSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as asar from "@electron/asar";
import { readSidecars, readUpstream } from "./lib/manifest.js";
import { deriveVersions } from "./lib/versions.js";
import { run } from "./lib/exec.js";
import { APP_DIR, ELECTRON_DIR, BUN_DIR, UV_DIR, WIN_APP_DIR, UNPACKED_DIR } from "./lib/paths.js";

const EXECUTABLES = ["qwen-studio", "chrome-sandbox", "chrome_crashpad_handler", "resources/bun/bun", "resources/python/uv", "resources/python/uvx"];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`assemble: ${msg}`);
    process.exit(5);
  }
}

export async function assemble(): Promise<void> {
  const sc = readSidecars();
  const appVersion = deriveVersions(readUpstream()).appVersion;

  rmSync(UNPACKED_DIR, { recursive: true, force: true });
  cpSync(ELECTRON_DIR, UNPACKED_DIR, { recursive: true });
  renameSync(path.join(UNPACKED_DIR, "electron"), path.join(UNPACKED_DIR, "qwen-studio"));

  const res = path.join(UNPACKED_DIR, "resources");
  rmSync(path.join(res, "default_app.asar"), { force: true });
  mkdirSync(res, { recursive: true });

  await asar.createPackage(APP_DIR, path.join(res, "app.asar"));
  cpSync(path.join(WIN_APP_DIR, "resources", "assets"), path.join(res, "assets"), { recursive: true });
  cpSync(path.join(WIN_APP_DIR, "resources", "i18n"), path.join(res, "i18n"), { recursive: true });
  mkdirSync(path.join(res, "bun"));
  mkdirSync(path.join(res, "python"));
  copyFileSync(path.join(BUN_DIR, sc.bun.extract!.bun), path.join(res, "bun", "bun"));
  copyFileSync(path.join(UV_DIR, sc.uv.extract!.uv), path.join(res, "python", "uv"));
  copyFileSync(path.join(UV_DIR, sc.uv.extract!.uvx), path.join(res, "python", "uvx"));
  for (const f of EXECUTABLES) chmodSync(path.join(UNPACKED_DIR, f), 0o755);

  // Post-conditions (spec §10.4)
  assert(existsSync(path.join(UNPACKED_DIR, "qwen-studio")), "qwen-studio missing");
  assert(!existsSync(path.join(res, "default_app.asar")), "default_app.asar still present");
  for (const f of ["elevate.exe", "app-update.yml", "bun/bun.exe", "python/uv.exe", "python/uvx.exe"]) {
    assert(!existsSync(path.join(res, f)), `${f} must not be shipped`);
  }
  assert(readdirSync(path.join(res, "i18n")).filter((f) => f.endsWith(".json")).length === 12, "expected 12 i18n files");
  const files = asar.listPackage(path.join(res, "app.asar"), { isPack: false });
  assert(files.includes(path.join(path.sep, "out", "main", "linux-update.js")), "app.asar lacks out/main/linux-update.js");
  const pkg = JSON.parse(asar.extractFile(path.join(res, "app.asar"), "package.json").toString("utf8")) as { version: string };
  assert(pkg.version === appVersion, `app.asar version ${pkg.version} != ${appVersion}`);
  assert(run(path.join(res, "bun", "bun"), ["--version"], { capture: true }).trim() === sc.bun.version, "bun --version mismatch");
  assert(run(path.join(res, "python", "uvx"), ["--version"], { capture: true }).startsWith(`uvx ${sc.uv.version}`), "uvx --version mismatch");
  assert(run(path.join(res, "python", "uv"), ["--version"], { capture: true }).startsWith(`uv ${sc.uv.version}`), "uv --version mismatch");
  assert(readFileSync(path.join(UNPACKED_DIR, "version"), "utf8").trim() === sc.electron.version, "Electron version file mismatch");

  console.log(`assembled ${UNPACKED_DIR} (app ${appVersion}, electron ${sc.electron.version})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) assemble();
