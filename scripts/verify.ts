import { readdirSync, readFileSync, statSync, existsSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import * as asar from "@electron/asar";
import { run } from "./lib/exec.js";
import { debControl, debFiles, debExtract } from "./lib/deb.js";
import { readUpstream } from "./lib/manifest.js";
import { deriveVersions } from "./lib/versions.js";
import { sha512Base64File } from "./lib/hash.js";
import { DIST_DIR, BUILD_DIR } from "./lib/paths.js";
import { PACKAGE_LICENSE } from "./lib/electron-builder-config.js";

export const DEB_EXEC_RE = /^"?\/opt\/Qwen Studio\/qwen-studio"? --ozone-platform-hint=auto %U$/;
export const APPIMAGE_EXEC_RE = /^AppRun --ozone-platform-hint=auto %U$/;

export function parseDesktopEntry(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9-]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function assertDesktop(e: Record<string, string>, execRe: RegExp): void {
  if (!execRe.test(e.Exec ?? "")) throw new Error(`desktop Exec line wrong: ${e.Exec}`);
  if (e.Categories !== "Network;Chat;") throw new Error(`desktop Categories wrong: ${e.Categories}`);
  if (e.MimeType !== "x-scheme-handler/qwen;") throw new Error(`desktop MimeType wrong: ${e.MimeType}`);
  if (e.StartupWMClass !== "Qwen Studio") throw new Error(`desktop StartupWMClass wrong: ${e.StartupWMClass}`);
}

const failures: string[] = [];
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (e) {
    failures.push(`${label}: ${(e as Error).message}`);
    console.log(`FAIL ${label}: ${(e as Error).message}`);
  }
}
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (e) {
    failures.push(`${label}: ${(e as Error).message}`);
    console.log(`FAIL ${label}: ${(e as Error).message}`);
  }
}
function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const REQUIRED_PATHS = [
  "opt/Qwen Studio/qwen-studio",
  "opt/Qwen Studio/resources/bun/bun",
  "opt/Qwen Studio/resources/python/uvx",
  "usr/share/applications/qwen-studio.desktop",
  "usr/share/icons/hicolor/512x512/apps/qwen-studio.png",
];

export async function verifyAll(): Promise<void> {
  const v = deriveVersions(readUpstream());
  const deb = path.join(DIST_DIR, v.artifacts.deb);
  const rpm = path.join(DIST_DIR, v.artifacts.rpm);
  const app = path.join(DIST_DIR, v.artifacts.appImage);
  const ymlPath = path.join(DIST_DIR, "latest-linux.yml");
  const work = path.join(BUILD_DIR, "verify");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  check("dist contains exactly the four expected files", () => {
    eq(
      readdirSync(DIST_DIR).sort().join(","),
      [v.artifacts.appImage, v.artifacts.rpm, v.artifacts.deb, "latest-linux.yml"].sort().join(","),
      "dist listing",
    );
  });

  check("deb control fields", () => {
    const fields = debControl(deb);
    eq(fields.Version, v.debVersion, "deb Version");
    eq(fields.Package, "qwen-studio", "deb Package");
    eq(fields.Architecture, "amd64", "deb Architecture");
    // Regression guard: electron-builder passes package.json's "MIT" as `--license` before our
    // deb.fpm `--license`; fpm keeps the last one. If that ordering ever changes, the .deb would
    // silently claim the proprietary Qwen Studio payload is MIT.
    eq(fields.License, PACKAGE_LICENSE, "deb License");
  });

  check("deb payload paths", () => {
    const list = debFiles(deb);
    for (const p of REQUIRED_PATHS) if (!list.includes(`./${p}`)) throw new Error(`missing ./${p}`);
  });

  check("deb desktop entry and asar version", () => {
    const x = path.join(work, "deb");
    debExtract(deb, x);
    const desktop = path.join(x, "usr/share/applications/qwen-studio.desktop");
    assertDesktop(parseDesktopEntry(readFileSync(desktop, "utf8")), DEB_EXEC_RE);
    run("desktop-file-validate", [desktop]);
    const pkg = JSON.parse(
      asar.extractFile(path.join(x, "opt/Qwen Studio/resources/app.asar"), "package.json").toString("utf8"),
    ) as { version: string };
    eq(pkg.version, v.appVersion, "asar package.json version");
  });

  check("rpm header fields and payload", () => {
    eq(
      run("rpm", ["-qp", "--qf", "%{NAME} %{VERSION} %{RELEASE} %{ARCH}", rpm], { capture: true }).trim(),
      `qwen-studio ${v.rpmVersion} ${v.rpmRelease} x86_64`,
      "rpm NVR",
    );
    // Same last-wins `--license` guard as the deb control check above, for the rpm header.
    eq(run("rpm", ["-qp", "--qf", "%{LICENSE}", rpm], { capture: true }).trim(), PACKAGE_LICENSE, "rpm LICENSE");
    const list = run("rpm", ["-qpl", rpm], { capture: true });
    for (const p of REQUIRED_PATHS) if (!list.includes(`/${p}`)) throw new Error(`missing /${p}`);
  });

  check("rpm desktop entry", () => {
    const x = path.join(work, "rpm");
    mkdirSync(x, { recursive: true });
    run("bash", ["-c", `rpm2cpio "${rpm}" | cpio -idm --quiet`], { cwd: x });
    const desktop = path.join(x, "usr/share/applications/qwen-studio.desktop");
    assertDesktop(parseDesktopEntry(readFileSync(desktop, "utf8")), DEB_EXEC_RE);
    run("desktop-file-validate", [desktop]);
  });

  check("AppImage extracts, has no package-type, desktop entry correct", () => {
    if (!(statSync(app).mode & 0o111)) throw new Error("AppImage not executable");
    const x = path.join(work, "appimage");
    mkdirSync(x, { recursive: true });
    run(app, ["--appimage-extract"], { cwd: x, capture: true });
    const root = path.join(x, "squashfs-root");
    if (existsSync(path.join(root, "resources/package-type"))) throw new Error("resources/package-type must not exist in the AppImage");
    if (!existsSync(path.join(root, "resources/bun/bun"))) throw new Error("resources/bun/bun missing");
    const desktop = path.join(root, "qwen-studio.desktop");
    assertDesktop(parseDesktopEntry(readFileSync(desktop, "utf8")), APPIMAGE_EXEC_RE);
    run("desktop-file-validate", [desktop]);
  });

  await checkAsync("latest-linux.yml matches the AppImage", async () => {
    const y = yaml.load(readFileSync(ymlPath, "utf8")) as {
      version: string;
      path: string;
      sha512: string;
      files: Array<{ url: string; sha512: string; size: number }>;
    };
    eq(y.version, v.appVersion, "latest-linux.yml version");
    eq(y.path, v.artifacts.appImage, "latest-linux.yml path");
    eq(y.files[0].url, v.artifacts.appImage, "latest-linux.yml files[0].url");
    eq(y.sha512, await sha512Base64File(app), "latest-linux.yml sha512");
    // electron-builder's UpdateInfo schema only carries `size` under `files[0]`, not at the
    // top level; there is no top-level `size` key to compare against.
    eq(y.files[0].size, statSync(app).size, "latest-linux.yml files[0].size");
  });

  if (failures.length) {
    console.error(`\n${failures.length} verification failure(s):\n- ${failures.join("\n- ")}`);
    process.exit(6);
  }
  console.log("\nall artifact verifications passed");
}

// Like build.ts's main(): anything thrown OUTSIDE the individual check()/checkAsync() wrappers
// (a missing dist/, an unreadable upstream.json, ...) is reported as a one-line failure instead
// of an unhandled-rejection stack dump. Failures inside checks already exit(6) in verifyAll().
export async function main(): Promise<void> {
  try {
    await verifyAll();
  } catch (e) {
    console.error(`verify failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(6);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
