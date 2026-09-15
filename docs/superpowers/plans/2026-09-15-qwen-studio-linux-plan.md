# Qwen Studio for Linux Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Alibaba's Qwen Studio desktop app as native Linux packages (.deb, .rpm, AppImage, x86_64) from a public GitHub repository with CI, an install/launch test matrix, automatic releases and fully automatic upstream-version tracking.

**Architecture:** TypeScript scripts under `scripts/` download the upstream Windows installer (SHA-512 verified), extract `app.asar`, apply two unified-diff patches, assemble an Electron 35.1.4 linux-x64 tree with Linux `bun`/`uv`/`uvx` sidecars, and drive `electron-builder --prepackaged` once per target. GitHub Actions runs unit tests, a full build, package linters, and a Docker install+headless-launch matrix on every PR; a release workflow publishes on merge to `main`; a daily bot opens auto-merging PRs for new upstream versions.

**Tech Stack:** Node 22 LTS, TypeScript 5 via `tsx`, vitest, `@electron/asar`, `sharp`, `electron-builder 26.15.3`, `electron-updater 6.6.2` (dev, for tests), `semver`, `js-yaml`, GitHub Actions, Docker, `xvfb-run`, `lintian`, `rpmlint`.

**Spec:** `docs/superpowers/specs/2026-09-15-qwen-studio-linux-design.md` (referred to below as "the spec"; section numbers like §10.7 refer to it). Executors must read the spec section named in each task before starting the task.

## Global Constraints

- Only x86_64. Only `.deb`, `.rpm`, `.AppImage`.
- Package/executable name `qwen-studio`; productName `Qwen Studio`; appId `ai.qwen.studio`; URL scheme `qwen`; categories `Network;Chat;`.
- Node `22` (`.nvmrc`), `"type": "module"`, all scripts TypeScript run by `tsx`. Tests with `vitest`.
- Pinned tool versions: `electron-builder@26.15.3`, `electron-updater@6.6.2` (devDependency, tests only), Electron `35.1.4`, bun `1.2.10` (baseline), uv `0.12.15`.
- `upstream.json` and `sidecars.json` are the only inputs; `deriveVersions()` in `scripts/lib/versions.ts` is the only place version strings are derived. Example: app `1.0.3-44.1`, deb `1.0.3.44-1`, rpm `1.0.3.44`/`1`, tag `v1.0.3.44-1`.
- Patches are unified diffs in `patches/NNNN-*.patch` applied with `git apply` (`--check` first; failure is a hard error, exit 2).
- Never commit `*.exe`, `.cache/`, `build/`, `dist/`, `node_modules/`.
- Never ship `--no-sandbox` (test-only flag in `tests/smoke/smoke.sh`).
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, `build:`) and end with the attribution trailer required by the executing session (the commit steps show `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` as the example; substitute the trailer your session mandates if it differs).
- Upstream feed: `https://download.qwen.ai/windows/x64/latest.yml`; installer URL = feed base + `files[0].url`; verify SHA-512 only (feed `size` is wrong upstream and is never enforced).
- GitHub: owner `sams-git-195`, repo `qwenstudio-linux`. Releases are normal releases marked latest (never prerelease/draft). Channel file `latest-linux.yml`.
- Local dev host is Fedora 44 with `7z`, Node 24 via nvm (use `nvm install 22 && nvm use 22`), no Docker verification required locally except where a task says so; CI runner is `ubuntu-22.04`.

---

## File structure

| Path | Responsibility |
|---|---|
| `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`, `.editorconfig`, `.gitignore`, `commitlint.config.cjs` | Tooling |
| `upstream.json`, `sidecars.json` | Input manifests (§6) |
| `scripts/lib/paths.ts` | Directory constants (`ROOT`, `CACHE_DIR`, `BUILD_DIR`, `DIST_DIR`, ...) |
| `scripts/lib/manifest.ts` | Manifest types, validation, feed parsing |
| `scripts/lib/versions.ts` | `deriveVersions()` |
| `scripts/lib/hash.ts` | `sha256File`, `sha512Base64File` |
| `scripts/lib/download.ts` | `downloadWithRetry`, `fetchCached` |
| `scripts/lib/exec.ts` | `run()` wrapper around `spawnSync` |
| `scripts/lib/electron-builder-config.ts` | `buildConfig(target)` |
| `scripts/fetch.ts`, `extract.ts`, `patch.ts`, `assemble.ts`, `icons.ts`, `build.ts`, `verify.ts`, `version.ts` | Pipeline stages (§10) |
| `scripts/changelog.ts`, `scripts/upstream-check.ts` | Release/bot logic (§12) |
| `src/app/linux-update.js` | Notify-only updater module shipped inside `app.asar` (§8.3) |
| `patches/0001-linux-platform-dir.patch`, `patches/0002-linux-updater.patch` | Upstream patches (§8) |
| `packaging/electron-builder.base.json`, `packaging/lintian/qwen-studio.overrides`, `packaging/rpmlint/qwen-studio.toml` | Packaging metadata (§10.7, §11.3) |
| `tests/unit/*.test.ts`, `tests/fixtures/*` | Unit tests and fixtures |
| `tests/smoke/smoke.sh`, `tests/install/install-and-smoke.sh` | Headless launch and container install checks (§11.4, §11.5) |
| `.github/workflows/{build-and-test,ci,release,upstream-check,codeql}.yml`, `.github/dependabot.yml`, `.github/CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/*` | CI and repo governance |
| `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/RELEASING.md`, `docs/BRANCH_PROTECTION.md` | Documentation (§14) |

## Workstreams, ordering and parallelism

```
A (Pipeline scripts) ──► B (Packaging) ──► C (CI matrix) ──► D (Release + bot) ──► F (Final QA)
E (Governance docs) ── independent; can run in parallel with A–D, must be merged before F
```

- **A1 must be the very first task** (it removes the `.exe` hazard and bootstraps tooling). After A1: A2, A3, A4 are independent of each other and may run in parallel. A5 needs A4. A6 is independent (after A1). A7 needs A5 and A6. A8 needs A5 and A7 (A8's icons half needs only A5). A9 needs A8.
- B1 needs A3. B2 needs A9 and B1. B3, B4, B5 need B2 and are independent of each other.
- C1 needs A8 (smoke against `build/linux-unpacked`). C2 needs B2 and C1. C3 needs B3, B5, C2. C4 needs C3. C5 is independent of C1–C4 (needs only A1) and may run in parallel with them.
- D1 needs A1 only (may run in parallel with B/C). D2 needs C3 and D1. D3 needs A2, A4, A5, A7, D1. D4 needs D3. D5 needs D2 and D4.
- E1–E4 need only A1; all four may run in parallel with everything.
- F runs alone, last, after A–E are merged and the owner has applied §13 settings.

Task count: A = 9, B = 5, C = 5, D = 5, E = 4, F = 1 (29 tasks).

Every task: work on a branch off `main`, one commit per task (or per step where shown), open a PR titled with the commit subject once C4 exists; before C4 exists, merge directly to `main` after `npm run test:unit` passes locally.

---

# Workstream A — Pipeline scripts

### Task A1: Repository bootstrap and `.exe` hazard removal

**Spec:** §5, Global Constraints.

**Files:**
- Create: `.gitignore`, `.nvmrc`, `.editorconfig`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `commitlint.config.cjs`, `tests/unit/smoke-tooling.test.ts`
- Do NOT touch: `Qwen-1.0.3.44-release-win-x64.exe` (leave the file on disk, untracked and ignored)

**Interfaces:**
- Produces: npm scripts `typecheck`, `test:unit`, `fetch`, `extract`, `patch`, `assemble`, `icons`, `build`, `verify`, `version`, `patches:dev`, `patches:export`, `changelog`, `upstream-check` (script files are created by later tasks; the entries exist now).

- [ ] **Step 1: Create `.gitignore`, `.nvmrc`, `.editorconfig`**

`.gitignore`:
```
*.exe
.cache/
build/
dist/
node_modules/
*.log
smoke.log
```

`.nvmrc`:
```
22
```

`.editorconfig`:
```
root = true
[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
```

- [ ] **Step 2: Verify the installer is ignored**

Run: `cd /home/sam/Documents/GitHub/qwenstudio-linux && git status --short`
Expected: exactly the new files listed as `??`; the `.exe` is **absent** from the output. `git check-ignore Qwen-1.0.3.44-release-win-x64.exe` prints the filename.

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "qwen-studio",
  "version": "0.0.0-wrapper",
  "private": true,
  "description": "Unofficial Linux packaging of Qwen Studio (Alibaba's desktop client for chat.qwen.ai)",
  "homepage": "https://github.com/sams-git-195/qwenstudio-linux",
  "license": "MIT",
  "author": "sams-git-195 <samheard95@gmail.com>",
  "type": "module",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run",
    "fetch": "tsx scripts/fetch.ts",
    "extract": "tsx scripts/extract.ts",
    "patch": "tsx scripts/patch.ts",
    "assemble": "tsx scripts/assemble.ts",
    "icons": "tsx scripts/icons.ts",
    "build": "tsx scripts/build.ts",
    "verify": "tsx scripts/verify.ts",
    "version": "tsx scripts/version.ts",
    "patches:dev": "tsx scripts/build.ts --until patch",
    "patches:export": "tsx scripts/patch.ts --export",
    "changelog": "tsx scripts/changelog.ts",
    "upstream-check": "tsx scripts/upstream-check.ts"
  },
  "devDependencies": {
    "@commitlint/cli": "21.2.2",
    "@commitlint/config-conventional": "21.2.2",
    "@electron/asar": "4.3.0",
    "@types/js-yaml": "4.0.9",
    "@types/node": "22.15.3",
    "@types/semver": "7.7.0",
    "electron-builder": "26.15.3",
    "electron-updater": "6.6.2",
    "js-yaml": "4.1.0",
    "semver": "7.7.2",
    "sharp": "0.35.4",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "5.0.1"
  }
}
```

Note: `npm run version` collides with npm's built-in `version` lifecycle only when invoked as `npm version`; `npm run version` runs our script. If `npm install` fails on a pinned version that no longer exists, run `npm view <pkg> versions --json | tail -5` and pin the closest newer patch release, recording the change in the commit body.

- [ ] **Step 4: Create `tsconfig.json`, `vitest.config.ts`, `commitlint.config.cjs`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["scripts/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/unit/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
});
```

`commitlint.config.cjs`:
```js
module.exports = { extends: ["@commitlint/config-conventional"] };
```

- [ ] **Step 5: Write a tooling smoke test**

`tests/unit/smoke-tooling.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("tooling", () => {
  it("ignores installers", () => {
    expect(readFileSync(".gitignore", "utf8").split("\n")).toContain("*.exe");
  });
});
```

- [ ] **Step 6: Install and run**

Run: `source ~/.nvm/nvm.sh && nvm install 22 && nvm use 22 && npm install && npm run typecheck && npm run test:unit`
Expected: `npm install` creates `package-lock.json`; typecheck passes (no TS files yet besides the test); vitest reports 1 passed.

- [ ] **Step 7: Commit**

```bash
git add .gitignore .nvmrc .editorconfig package.json package-lock.json tsconfig.json vitest.config.ts commitlint.config.cjs tests/unit/smoke-tooling.test.ts
git status --short   # must NOT list the .exe
git commit -m "build: bootstrap tooling and ignore upstream installers" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A2: Manifests and `scripts/lib/manifest.ts`

**Spec:** §3.1, §6, §11.1 (`manifest.test.ts`, `feed.test.ts`).

**Files:**
- Create: `upstream.json`, `sidecars.json`, `scripts/lib/paths.ts`, `scripts/lib/manifest.ts`, `tests/fixtures/latest.yml`, `tests/fixtures/latest-bad-filename.yml`, `tests/unit/manifest.test.ts`, `tests/unit/feed.test.ts`

**Interfaces:**
- Produces:
  - `paths.ts`: `ROOT`, `CACHE_DIR` (`.cache`), `BUILD_DIR` (`build`), `DIST_DIR` (`dist`), `APP_DIR` (`build/app`), `APP_PRISTINE_DIR` (`build/app-pristine`), `WIN_APP_DIR` (`build/win-app`), `ELECTRON_DIR` (`build/electron`), `BUN_DIR` (`build/bun`), `UV_DIR` (`build/uv`), `UNPACKED_DIR` (`build/linux-unpacked`), `ICONS_DIR` (`build/icons`), `LICENSES_DIR` (`build/licenses`), `PATCHES_DIR` (`patches`).
  - `manifest.ts`: types `UpstreamManifest`, `SidecarEntry`, `SidecarsManifest`, `FeedInfo`; `INSTALLER_RE`; `validateUpstream(obj: unknown): UpstreamManifest`; `validateSidecars(obj: unknown): SidecarsManifest`; `readUpstream(root?: string)`; `readSidecars(root?: string)`; `parseFeed(text: string, feedUrl: string): FeedInfo`.

- [ ] **Step 1: Create the manifests**

`upstream.json`:
```json
{
  "version": "1.0.3",
  "build": 44,
  "wrapper_revision": 1,
  "url": "https://download.qwen.ai/windows/x64/Qwen-1.0.3.44-release-win-x64.exe",
  "sha512": "i9mh4W2lC2YzTcV5L4uaMwwWj9pthH/uIZEi1/MuxtLIyC53ZFgrETzdACJMECAwnI0VtYOLlI/gHm+gsfj8qA==",
  "size": 124954112,
  "releaseDate": "2025-08-15T03:38:13.875Z"
}
```

`sidecars.json`:
```json
{
  "electron": {
    "version": "35.1.4",
    "url": "https://github.com/electron/electron/releases/download/v35.1.4/electron-v35.1.4-linux-x64.zip",
    "sha256": "19a6b1a90bb9c13ad5ba1dcb8ebe1b98d9f8b8488e7731e56199c2a4971d7b47"
  },
  "bun": {
    "version": "1.2.10",
    "url": "https://github.com/oven-sh/bun/releases/download/bun-v1.2.10/bun-linux-x64-baseline.zip",
    "sha256": "4b62f599048ef320a761bacbeeb71f8784f5e373b976a9d53b3ee7811f19b004",
    "extract": { "bun": "bun-linux-x64-baseline/bun" }
  },
  "uv": {
    "version": "0.12.15",
    "url": "https://github.com/astral-sh/uv/releases/download/0.12.15/uv-x86_64-unknown-linux-gnu.tar.gz",
    "sha256": "f97935763c04be3e692460a7aaeaaab8fc3b78fcf8b389da820b38ae7423a638",
    "extract": { "uv": "uv-x86_64-unknown-linux-gnu/uv", "uvx": "uv-x86_64-unknown-linux-gnu/uvx" }
  }
}
```

- [ ] **Step 2: Re-verify the checksums independently**

Run:
```bash
curl -sL https://github.com/electron/electron/releases/download/v35.1.4/SHASUMS256.txt | grep 'electron-v35.1.4-linux-x64.zip$'
curl -sL https://github.com/oven-sh/bun/releases/download/bun-v1.2.10/SHASUMS256.txt | grep 'bun-linux-x64-baseline.zip$'
curl -sL https://github.com/astral-sh/uv/releases/download/0.12.15/uv-x86_64-unknown-linux-gnu.tar.gz.sha256
```
Expected: the three hex strings equal the values in `sidecars.json`. If any differs, stop and report (do not edit the manifest).

- [ ] **Step 3: Create fixtures**

`tests/fixtures/latest.yml` (verbatim upstream feed):
```yaml
version: 1.0.3
files:
  - url: Qwen-1.0.3.44-release-win-x64.exe
    sha512: i9mh4W2lC2YzTcV5L4uaMwwWj9pthH/uIZEi1/MuxtLIyC53ZFgrETzdACJMECAwnI0VtYOLlI/gHm+gsfj8qA==
    size: 124943360
path: Qwen-1.0.3.44-release-win-x64.exe
sha512: i9mh4W2lC2YzTcV5L4uaMwwWj9pthH/uIZEi1/MuxtLIyC53ZFgrETzdACJMECAwnI0VtYOLlI/gHm+gsfj8qA==
releaseDate: '2025-08-15T03:38:13.875Z'
```

`tests/fixtures/latest-bad-filename.yml`:
```yaml
version: 1.0.3
files:
  - url: QwenStudio-Setup-1.0.3.exe
    sha512: i9mh4W2lC2YzTcV5L4uaMwwWj9pthH/uIZEi1/MuxtLIyC53ZFgrETzdACJMECAwnI0VtYOLlI/gHm+gsfj8qA==
    size: 1
path: QwenStudio-Setup-1.0.3.exe
sha512: i9mh4W2lC2YzTcV5L4uaMwwWj9pthH/uIZEi1/MuxtLIyC53ZFgrETzdACJMECAwnI0VtYOLlI/gHm+gsfj8qA==
releaseDate: '2025-08-15T03:38:13.875Z'
```

- [ ] **Step 4: Write failing tests**

`tests/unit/manifest.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateUpstream, validateSidecars, readUpstream, readSidecars } from "../../scripts/lib/manifest.js";

const good = JSON.parse(readFileSync("upstream.json", "utf8"));
const sidecars = JSON.parse(readFileSync("sidecars.json", "utf8"));

describe("validateUpstream", () => {
  it("accepts the committed manifest", () => {
    expect(validateUpstream(good)).toEqual(good);
    expect(readUpstream()).toEqual(good);
  });
  it("rejects a missing field", () => {
    const { build, ...rest } = good;
    expect(() => validateUpstream(rest)).toThrow(/upstream\.json: missing or invalid field "build"/);
  });
  it("rejects bad base64 sha512", () => {
    expect(() => validateUpstream({ ...good, sha512: "abc" })).toThrow(/sha512/);
  });
  it("rejects a non-download.qwen.ai URL", () => {
    expect(() => validateUpstream({ ...good, url: "https://example.com/x.exe" })).toThrow(/url/);
  });
  it("rejects a URL containing /latest/", () => {
    expect(() => validateUpstream({ ...good, url: "https://download.qwen.ai/latest/x.exe" })).toThrow(/latest/);
  });
});

describe("validateSidecars", () => {
  it("accepts the committed manifest", () => {
    expect(validateSidecars(sidecars)).toEqual(sidecars);
    expect(readSidecars()).toEqual(sidecars);
  });
  it("rejects /latest/ URLs", () => {
    const bad = { ...sidecars, uv: { ...sidecars.uv, url: "https://github.com/astral-sh/uv/releases/latest/download/uv.tar.gz" } };
    expect(() => validateSidecars(bad)).toThrow(/latest/);
  });
  it("rejects a non-hex sha256", () => {
    const bad = { ...sidecars, bun: { ...sidecars.bun, sha256: "zz" } };
    expect(() => validateSidecars(bad)).toThrow(/sha256/);
  });
});
```

`tests/unit/feed.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFeed } from "../../scripts/lib/manifest.js";

const FEED = "https://download.qwen.ai/windows/x64/latest.yml";

describe("parseFeed", () => {
  it("parses the verbatim upstream feed", () => {
    const info = parseFeed(readFileSync("tests/fixtures/latest.yml", "utf8"), FEED);
    expect(info).toEqual({
      version: "1.0.3",
      build: 44,
      url: "https://download.qwen.ai/windows/x64/Qwen-1.0.3.44-release-win-x64.exe",
      sha512: "i9mh4W2lC2YzTcV5L4uaMwwWj9pthH/uIZEi1/MuxtLIyC53ZFgrETzdACJMECAwnI0VtYOLlI/gHm+gsfj8qA==",
      size: 124943360,
      releaseDate: "2025-08-15T03:38:13.875Z",
    });
  });
  it("rejects a filename that does not match the installer pattern", () => {
    expect(() => parseFeed(readFileSync("tests/fixtures/latest-bad-filename.yml", "utf8"), FEED)).toThrow(/does not match/);
  });
  it("rejects a version/filename mismatch", () => {
    const text = readFileSync("tests/fixtures/latest.yml", "utf8").replace("version: 1.0.3", "version: 1.0.4");
    expect(() => parseFeed(text, FEED)).toThrow(/mismatch/);
  });
  it("resolves absolute file URLs as-is", () => {
    const text = readFileSync("tests/fixtures/latest.yml", "utf8").replace(
      "- url: Qwen-1.0.3.44-release-win-x64.exe",
      "- url: https://cdn.example.com/Qwen-1.0.3.44-release-win-x64.exe",
    );
    expect(parseFeed(text, FEED).url).toBe("https://cdn.example.com/Qwen-1.0.3.44-release-win-x64.exe");
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run tests/unit/manifest.test.ts tests/unit/feed.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/lib/manifest.js'`.

- [ ] **Step 6: Implement `scripts/lib/paths.ts`**

```ts
import path from "node:path";

export const ROOT = process.cwd();
export const CACHE_DIR = path.join(ROOT, ".cache");
export const BUILD_DIR = path.join(ROOT, "build");
export const DIST_DIR = path.join(ROOT, "dist");
export const PATCHES_DIR = path.join(ROOT, "patches");
export const APP_DIR = path.join(BUILD_DIR, "app");
export const APP_PRISTINE_DIR = path.join(BUILD_DIR, "app-pristine");
export const WIN_APP_DIR = path.join(BUILD_DIR, "win-app");
export const NSIS_DIR = path.join(BUILD_DIR, "nsis");
export const ELECTRON_DIR = path.join(BUILD_DIR, "electron");
export const BUN_DIR = path.join(BUILD_DIR, "bun");
export const UV_DIR = path.join(BUILD_DIR, "uv");
export const UNPACKED_DIR = path.join(BUILD_DIR, "linux-unpacked");
export const ICONS_DIR = path.join(BUILD_DIR, "icons");
export const LICENSES_DIR = path.join(BUILD_DIR, "licenses");
```

- [ ] **Step 7: Implement `scripts/lib/manifest.ts`**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface UpstreamManifest {
  version: string;
  build: number;
  wrapper_revision: number;
  url: string;
  sha512: string;
  size: number;
  releaseDate: string;
}
export interface SidecarEntry { version: string; url: string; sha256: string; extract?: Record<string, string> }
export interface SidecarsManifest { electron: SidecarEntry; bun: SidecarEntry; uv: SidecarEntry }
export interface FeedInfo { version: string; build: number; url: string; sha512: string; size: number; releaseDate: string }

export const INSTALLER_RE = /^Qwen-(\d+\.\d+\.\d+)\.(\d+)-release-win-x64\.exe$/;
const SEMVER_CORE = /^\d+\.\d+\.\d+$/;
const B64_SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function fail(file: string, field: string): never {
  throw new Error(`${file}: missing or invalid field "${field}"`);
}
function isObj(x: unknown): x is Record<string, unknown> { return typeof x === "object" && x !== null; }

export function validateUpstream(obj: unknown): UpstreamManifest {
  const f = "upstream.json";
  if (!isObj(obj)) throw new Error(`${f}: not an object`);
  const o = obj;
  if (typeof o.version !== "string" || !SEMVER_CORE.test(o.version)) fail(f, "version");
  if (!Number.isInteger(o.build) || (o.build as number) < 0) fail(f, "build");
  if (!Number.isInteger(o.wrapper_revision) || (o.wrapper_revision as number) < 1) fail(f, "wrapper_revision");
  if (typeof o.url !== "string" || !o.url.startsWith("https://download.qwen.ai/")) fail(f, "url");
  if (o.url.includes("/latest/")) throw new Error(`${f}: url must not contain /latest/`);
  if (typeof o.sha512 !== "string" || !B64_SHA512.test(o.sha512)) fail(f, "sha512");
  if (!Number.isInteger(o.size) || (o.size as number) <= 0) fail(f, "size");
  if (typeof o.releaseDate !== "string" || Number.isNaN(Date.parse(o.releaseDate))) fail(f, "releaseDate");
  return {
    version: o.version, build: o.build as number, wrapper_revision: o.wrapper_revision as number,
    url: o.url, sha512: o.sha512, size: o.size as number, releaseDate: o.releaseDate,
  };
}

function validateEntry(name: string, e: unknown): SidecarEntry {
  const f = `sidecars.json[${name}]`;
  if (!isObj(e)) throw new Error(`${f}: not an object`);
  if (typeof e.version !== "string" || e.version.length === 0) fail(f, "version");
  if (typeof e.url !== "string" || !e.url.startsWith("https://")) fail(f, "url");
  if (e.url.includes("/latest/")) throw new Error(`${f}: url must not contain /latest/ (pin an explicit version)`);
  if (typeof e.sha256 !== "string" || !HEX_SHA256.test(e.sha256)) fail(f, "sha256");
  const out: SidecarEntry = { version: e.version, url: e.url, sha256: e.sha256 };
  if (e.extract !== undefined) {
    if (!isObj(e.extract) || Object.values(e.extract).some((v) => typeof v !== "string")) fail(f, "extract");
    out.extract = e.extract as Record<string, string>;
  }
  return out;
}

export function validateSidecars(obj: unknown): SidecarsManifest {
  if (!isObj(obj)) throw new Error("sidecars.json: not an object");
  return {
    electron: validateEntry("electron", obj.electron),
    bun: validateEntry("bun", obj.bun),
    uv: validateEntry("uv", obj.uv),
  };
}

export function readUpstream(root = process.cwd()): UpstreamManifest {
  return validateUpstream(JSON.parse(readFileSync(path.join(root, "upstream.json"), "utf8")));
}
export function readSidecars(root = process.cwd()): SidecarsManifest {
  return validateSidecars(JSON.parse(readFileSync(path.join(root, "sidecars.json"), "utf8")));
}

export function parseFeed(text: string, feedUrl: string): FeedInfo {
  const doc = yaml.load(text) as Record<string, unknown>;
  if (!isObj(doc)) throw new Error("feed: not a YAML mapping");
  const files = doc.files as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(files) || files.length === 0 || !isObj(files[0])) throw new Error("feed: files[0] missing");
  const f0 = files[0];
  if (typeof f0.url !== "string") throw new Error("feed: files[0].url missing");
  const abs = new URL(f0.url, feedUrl).toString();
  const basename = abs.split("/").pop() ?? "";
  const m = INSTALLER_RE.exec(basename);
  if (!m) throw new Error(`feed: installer filename "${basename}" does not match ${INSTALLER_RE}`);
  const version = String(doc.version ?? "");
  if (m[1] !== version) throw new Error(`feed: version mismatch: feed says ${version}, filename says ${m[1]}`);
  if (typeof f0.sha512 !== "string" || !B64_SHA512.test(f0.sha512)) throw new Error("feed: files[0].sha512 invalid");
  const size = Number(f0.size);
  const releaseDate = String(doc.releaseDate ?? "");
  if (Number.isNaN(Date.parse(releaseDate))) throw new Error("feed: releaseDate invalid");
  return { version, build: Number(m[2]), url: abs, sha512: f0.sha512, size, releaseDate };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/unit/manifest.test.ts tests/unit/feed.test.ts && npm run typecheck`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add upstream.json sidecars.json scripts/lib/paths.ts scripts/lib/manifest.ts tests/fixtures/latest.yml tests/fixtures/latest-bad-filename.yml tests/unit/manifest.test.ts tests/unit/feed.test.ts
git commit -m "feat: add upstream and sidecar manifests with validation and feed parsing" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A3: `deriveVersions()` and the `version` CLI

**Spec:** §7.

**Files:**
- Create: `scripts/lib/versions.ts`, `scripts/version.ts`, `tests/unit/versions.test.ts`

**Interfaces:**
- Consumes: `UpstreamManifest` from A2.
- Produces: `deriveVersions(u: Pick<UpstreamManifest, "version" | "build" | "wrapper_revision">): DerivedVersions` with fields `appVersion, upstreamLabel, debVersion, rpmVersion, rpmRelease, gitTag, releaseName, artifacts: { deb, rpm, appImage }`; `npm run version -- --print <field>`, `--json`; writes `build/version.json`.

- [ ] **Step 1: Write the failing test**

`tests/unit/versions.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import os from "node:os";
import semver from "semver";
import { AppImageUpdater } from "electron-updater";
import { deriveVersions } from "../../scripts/lib/versions.js";

function fakeUpdater(version: string) {
  return new AppImageUpdater(
    { provider: "github", owner: "sams-git-195", repo: "qwenstudio-linux" },
    {
      version, name: "qwen-studio", isPackaged: true, appUpdateConfigPath: "/nonexistent/app-update.yml",
      userDataPath: os.tmpdir(), baseCachePath: os.tmpdir(),
      whenReady: async () => {}, quit() {}, relaunch() {}, onQuit() {},
    } as never,
  );
}
const info = (version: string) => ({ version, files: [], path: "", sha512: "", releaseDate: "" });

describe("deriveVersions", () => {
  it("derives every field for 1.0.3 build 44 rev 1", () => {
    expect(deriveVersions({ version: "1.0.3", build: 44, wrapper_revision: 1 })).toEqual({
      appVersion: "1.0.3-44.1",
      upstreamLabel: "1.0.3.44",
      debVersion: "1.0.3.44-1",
      rpmVersion: "1.0.3.44",
      rpmRelease: "1",
      gitTag: "v1.0.3.44-1",
      releaseName: "Qwen Studio 1.0.3.44 (linux-1)",
      artifacts: {
        deb: "qwen-studio_1.0.3.44-1_amd64.deb",
        rpm: "qwen-studio-1.0.3.44-1.x86_64.rpm",
        appImage: "qwen-studio-1.0.3.44-1-x86_64.AppImage",
      },
    });
  });
  it("derives every field for 1.0.4 build 1 rev 1", () => {
    const v = deriveVersions({ version: "1.0.4", build: 1, wrapper_revision: 1 });
    expect(v.appVersion).toBe("1.0.4-1.1");
    expect(v.debVersion).toBe("1.0.4.1-1");
    expect(v.gitTag).toBe("v1.0.4.1-1");
    expect(v.artifacts.appImage).toBe("qwen-studio-1.0.4.1-1-x86_64.AppImage");
  });
  it("orders releases with electron-updater's own comparator", async () => {
    const chain = ["1.0.3-44.1", "1.0.3-44.2", "1.0.3-44.10", "1.0.3-45.1", "1.0.4-1.1"];
    for (let i = 0; i < chain.length; i++) {
      const u = fakeUpdater(chain[i]);
      for (let j = 0; j < chain.length; j++) {
        expect(await u.isUpdateAvailable(info(chain[j])), `${chain[j]} vs current ${chain[i]}`).toBe(j > i);
      }
    }
  });
  it("documents that allowPrerelease defaults to true for our versions (patch 0002 sets it false)", () => {
    expect(fakeUpdater("1.0.3-44.1").allowPrerelease).toBe(true);
  });
  it("documents that tags are not semver and app versions are", () => {
    expect(semver.valid("1.0.3-44.1")).toBe("1.0.3-44.1");
    expect(semver.valid("1.0.3.44-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/versions.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/lib/versions.js'`.

- [ ] **Step 3: Implement `scripts/lib/versions.ts`**

```ts
import type { UpstreamManifest } from "./manifest.js";

export interface DerivedVersions {
  appVersion: string;
  upstreamLabel: string;
  debVersion: string;
  rpmVersion: string;
  rpmRelease: string;
  gitTag: string;
  releaseName: string;
  artifacts: { deb: string; rpm: string; appImage: string };
}

export function deriveVersions(u: Pick<UpstreamManifest, "version" | "build" | "wrapper_revision">): DerivedVersions {
  const upstreamLabel = `${u.version}.${u.build}`;
  const rev = String(u.wrapper_revision);
  const pkgVersion = `${upstreamLabel}-${rev}`;
  return {
    appVersion: `${u.version}-${u.build}.${rev}`,
    upstreamLabel,
    debVersion: pkgVersion,
    rpmVersion: upstreamLabel,
    rpmRelease: rev,
    gitTag: `v${pkgVersion}`,
    releaseName: `Qwen Studio ${upstreamLabel} (linux-${rev})`,
    artifacts: {
      deb: `qwen-studio_${pkgVersion}_amd64.deb`,
      rpm: `qwen-studio-${pkgVersion}.x86_64.rpm`,
      appImage: `qwen-studio-${pkgVersion}-x86_64.AppImage`,
    },
  };
}
```

- [ ] **Step 4: Implement `scripts/version.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readUpstream } from "./lib/manifest.js";
import { deriveVersions, type DerivedVersions } from "./lib/versions.js";
import { BUILD_DIR } from "./lib/paths.js";

export function writeVersionJson(): DerivedVersions {
  const v = deriveVersions(readUpstream());
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(path.join(BUILD_DIR, "version.json"), JSON.stringify(v, null, 2) + "\n");
  return v;
}

export function main(argv = process.argv.slice(2)): void {
  const v = writeVersionJson();
  const i = argv.indexOf("--print");
  if (i !== -1) {
    const field = argv[i + 1];
    const value = field.startsWith("artifacts.")
      ? v.artifacts[field.slice("artifacts.".length) as keyof DerivedVersions["artifacts"]]
      : (v as unknown as Record<string, unknown>)[field];
    if (value === undefined || typeof value === "object") { console.error(`Unknown field: ${field}`); process.exit(1); }
    process.stdout.write(String(value) + "\n");
    return;
  }
  if (argv.includes("--json")) { process.stdout.write(JSON.stringify(v, null, 2) + "\n"); return; }
  for (const [k, val] of Object.entries(v)) {
    console.log(typeof val === "object" ? `${k}: ${JSON.stringify(val)}` : `${k}: ${val}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 5: Run tests and CLI**

Run: `npx vitest run tests/unit/versions.test.ts && npm run typecheck && npm run -s version -- --print gitTag && npm run -s version -- --print artifacts.deb`
Expected: tests PASS; prints `v1.0.3.44-1` then `qwen-studio_1.0.3.44-1_amd64.deb`; `build/version.json` exists.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/versions.ts scripts/version.ts tests/unit/versions.test.ts
git commit -m "feat: derive all version strings from upstream.json" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A4: Download, hashing, exec helpers and `fetch.ts`

**Spec:** §10.1.

**Files:**
- Create: `scripts/lib/hash.ts`, `scripts/lib/exec.ts`, `scripts/lib/download.ts`, `scripts/fetch.ts`, `tests/unit/download.test.ts`

**Interfaces:**
- Produces:
  - `hash.ts`: `sha256File(p: string): Promise<string>` (hex), `sha512Base64File(p: string): Promise<string>`.
  - `exec.ts`: `run(cmd: string, args: string[], opts?: { cwd?: string; capture?: boolean; env?: NodeJS.ProcessEnv }): string` — throws `Error("<cmd> exited with <code>: <stderr>")` on non-zero; returns stdout when `capture`.
  - `download.ts`: `downloadWithRetry(url, dest, { retries = 3, fetchImpl = fetch })`, `fetchCached({ url, algo: "sha256" | "sha512", expected, cacheDir, fetchImpl }): Promise<string>` returning the cached file path; exit code 3 semantics via thrown `ChecksumMismatchError`.
  - `fetch.ts`: writes `build/fetch.json` `{ installer, electron, bun, uv }` (absolute paths).

- [ ] **Step 1: Write the failing test**

`tests/unit/download.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetchCached, ChecksumMismatchError } from "../../scripts/lib/download.js";
import { sha256File, sha512Base64File } from "../../scripts/lib/hash.js";

const body = Buffer.from("hello qwen studio");
const sha256 = createHash("sha256").update(body).digest("hex");
const sha512b64 = createHash("sha512").update(body).digest("base64");
let server: http.Server; let base = ""; let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.url === "/flaky" && hits === 1) { res.destroy(); return; }
    res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("fetchCached", () => {
  it("downloads, verifies and caches", async () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "qs-cache-"));
    const p = await fetchCached({ url: `${base}/file.bin`, algo: "sha256", expected: sha256, cacheDir });
    expect(p).toBe(path.join(cacheDir, sha256.slice(0, 12), "file.bin"));
    expect(readFileSync(p)).toEqual(body);
    const before = hits;
    await fetchCached({ url: `${base}/file.bin`, algo: "sha256", expected: sha256, cacheDir });
    expect(hits).toBe(before);
  });
  it("verifies sha512 base64", async () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "qs-cache-"));
    const p = await fetchCached({ url: `${base}/f.exe`, algo: "sha512", expected: sha512b64, cacheDir });
    expect(await sha512Base64File(p)).toBe(sha512b64);
    expect(await sha256File(p)).toBe(sha256);
  });
  it("deletes the file and throws on mismatch", async () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "qs-cache-"));
    const bad = "0".repeat(64);
    await expect(fetchCached({ url: `${base}/x.bin`, algo: "sha256", expected: bad, cacheDir })).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(existsSync(path.join(cacheDir, bad.slice(0, 12), "x.bin"))).toBe(false);
  });
  it("retries on network errors", async () => {
    hits = 0;
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "qs-cache-"));
    const p = await fetchCached({ url: `${base}/flaky`, algo: "sha256", expected: sha256, cacheDir, backoffMs: 1 });
    expect(readFileSync(p)).toEqual(body);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/download.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/lib/download.js'`.

- [ ] **Step 3: Implement `scripts/lib/hash.ts`**

```ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

function digestFile(p: string, algo: string, enc: "hex" | "base64"): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash(algo);
    createReadStream(p).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest(enc))).on("error", reject);
  });
}
export const sha256File = (p: string) => digestFile(p, "sha256", "hex");
export const sha512Base64File = (p: string) => digestFile(p, "sha512", "base64");
```

- [ ] **Step 4: Implement `scripts/lib/exec.ts`**

```ts
import { spawnSync } from "node:child_process";

export interface RunOpts { cwd?: string; capture?: boolean; env?: NodeJS.ProcessEnv; allowFailure?: boolean }

export function run(cmd: string, args: string[], opts: RunOpts = {}): string {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}: ${(r.stderr ?? "").toString().trim()}`);
  }
  return (r.stdout ?? "").toString();
}
```

- [ ] **Step 5: Implement `scripts/lib/download.ts`**

```ts
import { mkdirSync, existsSync, rmSync, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { sha256File, sha512Base64File } from "./hash.js";

export class ChecksumMismatchError extends Error {
  constructor(public url: string, public expected: string, public actual: string) {
    super(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
  }
}

export interface DownloadOpts { retries?: number; backoffMs?: number; fetchImpl?: typeof fetch }

export async function downloadWithRetry(url: string, dest: string, opts: DownloadOpts = {}): Promise<void> {
  const retries = opts.retries ?? 3; const backoff = opts.backoffMs ?? 1000; const f = opts.fetchImpl ?? fetch;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await f(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      rmSync(dest, { force: true });
      const { renameSync } = await import("node:fs");
      renameSync(tmp, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, backoff * 2 ** attempt));
    }
  }
  throw new Error(`Download failed after ${retries + 1} attempts: ${url}: ${(lastErr as Error)?.message}`);
}

export interface FetchCachedOpts extends DownloadOpts { url: string; algo: "sha256" | "sha512"; expected: string; cacheDir: string }

async function digest(p: string, algo: "sha256" | "sha512"): Promise<string> {
  return algo === "sha256" ? sha256File(p) : sha512Base64File(p);
}

export async function fetchCached(o: FetchCachedOpts): Promise<string> {
  const prefix = o.expected.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  const dest = path.join(o.cacheDir, prefix, path.basename(new URL(o.url).pathname));
  if (existsSync(dest) && (await digest(dest, o.algo)) === o.expected) return dest;
  await downloadWithRetry(o.url, dest, o);
  const actual = await digest(dest, o.algo);
  if (actual !== o.expected) { rmSync(dest, { force: true }); throw new ChecksumMismatchError(o.url, o.expected, actual); }
  return dest;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/unit/download.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Implement `scripts/fetch.ts`**

```ts
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readUpstream, readSidecars } from "./lib/manifest.js";
import { fetchCached, ChecksumMismatchError } from "./lib/download.js";
import { BUILD_DIR, CACHE_DIR } from "./lib/paths.js";

export interface FetchResult { installer: string; electron: string; bun: string; uv: string }

export async function fetchAll(): Promise<FetchResult> {
  const up = readUpstream(); const sc = readSidecars();
  const installer = await fetchCached({ url: up.url, algo: "sha512", expected: up.sha512, cacheDir: CACHE_DIR });
  const actualSize = statSync(installer).size;
  if (actualSize !== up.size) console.warn(`warning: upstream.json size ${up.size} != actual ${actualSize} (size is informational only)`);
  const [electron, bun, uv] = await Promise.all(
    [sc.electron, sc.bun, sc.uv].map((e) => fetchCached({ url: e.url, algo: "sha256", expected: e.sha256, cacheDir: CACHE_DIR })),
  );
  const result = { installer, electron, bun, uv };
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(path.join(BUILD_DIR, "fetch.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

export async function main(): Promise<void> {
  try {
    const r = await fetchAll();
    for (const [k, v] of Object.entries(r)) console.log(`${k}: ${v}`);
  } catch (e) {
    console.error(String((e as Error).message));
    process.exit(e instanceof ChecksumMismatchError ? 3 : 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 8: Run the real fetch (downloads ~330 MB once; the installer already on disk is reused if copied into the cache)**

Run:
```bash
mkdir -p .cache/i9mh4W2lC2Yz && cp Qwen-1.0.3.44-release-win-x64.exe .cache/i9mh4W2lC2Yz/
npm run fetch && cat build/fetch.json
```
Expected: four paths printed; the installer path is `.cache/i9mh4W2lC2Yz/Qwen-1.0.3.44-release-win-x64.exe` (hash verified, not re-downloaded); no `warning:` line about size (upstream.json holds the real size).

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/hash.ts scripts/lib/exec.ts scripts/lib/download.ts scripts/fetch.ts tests/unit/download.test.ts
git commit -m "feat: add verified, cached downloads and the fetch stage" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A5: `extract.ts` and the pristine `index.js` fixture

**Spec:** §3.2, §10.2.

**Files:**
- Create: `scripts/extract.ts`, `tests/fixtures/app-pristine/out/main/index.js` (copied from the real upstream file, see Step 5), `tests/unit/extract.test.ts`

**Interfaces:**
- Consumes: `build/fetch.json` from A4; `readUpstream`, `readSidecars` from A2; `run` from A4; path constants from A2.
- Produces: `extractAll(): Promise<void>` populating `build/nsis`, `build/win-app`, `build/app-pristine`, `build/app`, `build/electron`, `build/bun`, `build/uv`, `build/licenses`; `detectElectronVersion(exePath: string): string`.

Prerequisites on the dev host: `7z`, `unzip`, `tar` on PATH (Fedora: `sudo dnf install -y p7zip p7zip-plugins unzip`).

- [ ] **Step 1: Write the failing test**

`tests/unit/extract.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectElectronVersion } from "../../scripts/extract.js";

describe("detectElectronVersion", () => {
  it("finds the Electron/x.y.z marker in a binary", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qs-exe-"));
    const p = path.join(dir, "fake.exe");
    writeFileSync(p, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("Chrome/134.0.6998.179 Electron/35.1.4 Safari"), Buffer.from([0, 0])]));
    expect(detectElectronVersion(p)).toBe("35.1.4");
  });
  it("throws when no marker exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qs-exe-"));
    const p = path.join(dir, "fake.exe");
    writeFileSync(p, "nothing here");
    expect(() => detectElectronVersion(p)).toThrow(/Electron version marker not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/extract.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/extract.js'`.

- [ ] **Step 3: Implement `scripts/extract.ts`**

```ts
import { readFileSync, rmSync, mkdirSync, cpSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import asar from "@electron/asar";
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
```

- [ ] **Step 4: Run tests, then the real extraction**

Run: `npx vitest run tests/unit/extract.test.ts && npm run typecheck && npm run extract`
Expected: tests PASS; last line `extracted upstream 1.0.3.44 (Electron 35.1.4)`; `ls build/app/out/main/index.js build/electron/electron build/bun/bun-linux-x64-baseline/bun build/uv/uv-x86_64-unknown-linux-gnu/uvx build/licenses` all exist.

- [ ] **Step 5: Create the pristine fixture**

Run:
```bash
mkdir -p tests/fixtures/app-pristine/out/main
cp build/app-pristine/out/main/index.js tests/fixtures/app-pristine/out/main/index.js
wc -c tests/fixtures/app-pristine/out/main/index.js
grep -c 'Unsupported platform' tests/fixtures/app-pristine/out/main/index.js
```
Expected: about 22700 bytes; grep prints `1`.

- [ ] **Step 6: Commit**

```bash
git add scripts/extract.ts tests/unit/extract.test.ts tests/fixtures/app-pristine/out/main/index.js
git commit -m "feat: add extract stage and pristine upstream fixture" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A6: `src/app/linux-update.js` (notify-only updater)

**Spec:** §8.3, §9.

**Files:**
- Create: `src/app/linux-update.js`, `tests/fixtures/latest-linux.yml`, `tests/unit/linux-update.test.ts`

**Interfaces:**
- Produces (CommonJS exports): `isNotifyOnly(): boolean`, `parseLatestYaml(text): { version }`, `compare(current, latest): "newer" | "same" | "older"`, `check(opts): Promise<void>`, constants `FEED_URL`, `RELEASES_URL`. Consumed by patch `0002` (A7) as `require("./linux-update.js")`.

- [ ] **Step 1: Create the fixture**

`tests/fixtures/latest-linux.yml`:
```yaml
version: 1.0.3-44.2
files:
  - url: qwen-studio-1.0.3.44-2-x86_64.AppImage
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
    size: 123456789
path: qwen-studio-1.0.3.44-2-x86_64.AppImage
sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
releaseDate: '2026-09-15T00:00:00.000Z'
```

- [ ] **Step 2: Write the failing test**

`tests/unit/linux-update.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const mod = require("../../src/app/linux-update.js");
const yamlText = readFileSync("tests/fixtures/latest-linux.yml", "utf8");

function deps(response = 0, text = yamlText, fail = false) {
  const dialog = { showMessageBox: vi.fn(async () => ({ response })) };
  const shell = { openExternal: vi.fn(async () => {}) };
  const fetchImpl = vi.fn(async () => {
    if (fail) throw new Error("boom");
    return new Response(text, { status: 200 });
  });
  const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? ":" + JSON.stringify(o) : ""}`;
  return { dialog, shell, fetchImpl, t, icon: "/tmp/icon.png" };
}

const origPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: origPlatform });
  delete process.env.APPIMAGE;
});

describe("isNotifyOnly", () => {
  it("is true on linux without APPIMAGE", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(mod.isNotifyOnly()).toBe(true);
  });
  it("is false on linux with APPIMAGE", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.APPIMAGE = "/tmp/x.AppImage";
    expect(mod.isNotifyOnly()).toBe(false);
  });
  it("is false on other platforms", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(mod.isNotifyOnly()).toBe(false);
  });
});

describe("parseLatestYaml / compare", () => {
  it("parses the version line", () => expect(mod.parseLatestYaml(yamlText)).toEqual({ version: "1.0.3-44.2" }));
  it("throws without a version line", () => expect(() => mod.parseLatestYaml("files: []")).toThrow(/no version/));
  it("compares with semver", () => {
    expect(mod.compare("1.0.3-44.1", "1.0.3-44.2")).toBe("newer");
    expect(mod.compare("1.0.3-44.2", "1.0.3-44.2")).toBe("same");
    expect(mod.compare("1.0.3-45.1", "1.0.3-44.2")).toBe("older");
  });
});

describe("check", () => {
  it("shows the dialog and opens the releases page when newer", async () => {
    const d = deps(0);
    await mod.check({ manual: false, currentVersion: "1.0.3-44.1", ...d });
    expect(d.fetchImpl).toHaveBeenCalledWith(mod.FEED_URL, expect.objectContaining({ headers: expect.objectContaining({ "Cache-Control": "no-cache" }) }));
    expect(d.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(d.dialog.showMessageBox.mock.calls[0][0].buttons).toEqual(["update.download_now", "update.later"]);
    expect(d.shell.openExternal).toHaveBeenCalledWith(mod.RELEASES_URL);
  });
  it("does not open the page when the user picks Later", async () => {
    const d = deps(1);
    await mod.check({ manual: false, currentVersion: "1.0.3-44.1", ...d });
    expect(d.shell.openExternal).not.toHaveBeenCalled();
  });
  it("shows 'latest version' only for manual checks", async () => {
    const auto = deps(0);
    await mod.check({ manual: false, currentVersion: "1.0.3-44.2", ...auto });
    expect(auto.dialog.showMessageBox).not.toHaveBeenCalled();
    const manual = deps(0);
    await mod.check({ manual: true, currentVersion: "1.0.3-44.2", ...manual });
    expect(manual.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(manual.dialog.showMessageBox.mock.calls[0][0].message).toBe('update.latest_version:{"version":"1.0.3-44.2"}');
  });
  it("swallows fetch errors (dialog only when manual)", async () => {
    const auto = deps(0, yamlText, true);
    await expect(mod.check({ manual: false, currentVersion: "1.0.3-44.1", ...auto })).resolves.toBeUndefined();
    expect(auto.dialog.showMessageBox).not.toHaveBeenCalled();
    const manual = deps(0, yamlText, true);
    await mod.check({ manual: true, currentVersion: "1.0.3-44.1", ...manual });
    expect(manual.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/linux-update.test.ts`
Expected: FAIL with `Cannot find module '../../src/app/linux-update.js'`.

- [ ] **Step 4: Implement `src/app/linux-update.js`**

```js
"use strict";
// Notify-only update check for deb/rpm installs of Qwen Studio on Linux.
// Shipped inside app.asar as out/main/linux-update.js; required by patches/0002-linux-updater.patch.
// No Electron import at module level so the module is unit-testable in plain Node.
const semver = require("semver");

const FEED_URL = "https://github.com/sams-git-195/qwenstudio-linux/releases/latest/download/latest-linux.yml";
const RELEASES_URL = "https://github.com/sams-git-195/qwenstudio-linux/releases/latest";
const TIMEOUT_MS = 15000;

function isNotifyOnly() {
  return process.platform === "linux" && !process.env.APPIMAGE;
}

function parseLatestYaml(text) {
  const m = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(String(text));
  if (!m) throw new Error("latest-linux.yml: no version line");
  return { version: m[1] };
}

function compare(current, latest) {
  if (semver.gt(latest, current)) return "newer";
  if (semver.eq(latest, current)) return "same";
  return "older";
}

async function fetchText(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { "Cache-Control": "no-cache", Accept: "text/plain, */*" }, redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function showLatest({ dialog, icon, t, currentVersion }) {
  await dialog.showMessageBox({ type: "info", icon, message: t("update.latest_version", { version: currentVersion }) });
}

async function check({ manual, currentVersion, dialog, shell, net, t, icon, fetchImpl }) {
  const f = fetchImpl || (net && typeof net.fetch === "function" ? net.fetch.bind(net) : globalThis.fetch);
  try {
    const { version } = parseLatestYaml(await fetchText(FEED_URL, f));
    if (compare(currentVersion, version) === "newer") {
      console.log(`[linux-update] update available ${version}`);
      const { response } = await dialog.showMessageBox({
        type: "info",
        icon,
        title: t("update.new_version_found"),
        message: t("update.new_version_message", { version }),
        buttons: [t("update.download_now"), t("update.later")],
      });
      if (response === 0) await shell.openExternal(RELEASES_URL);
    } else {
      console.log(`[linux-update] up to date ${currentVersion}`);
      if (manual) await showLatest({ dialog, icon, t, currentVersion });
    }
  } catch (err) {
    console.error("[linux-update]", err && err.message ? err.message : err);
    if (manual) {
      try { await showLatest({ dialog, icon, t, currentVersion }); } catch (e) { console.error("[linux-update]", e); }
    }
  }
}

module.exports = { isNotifyOnly, parseLatestYaml, compare, check, FEED_URL, RELEASES_URL };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/linux-update.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add src/app/linux-update.js tests/fixtures/latest-linux.yml tests/unit/linux-update.test.ts
git commit -m "feat: add notify-only Linux update check module" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A7: Patches and `patch.ts`

**Spec:** §8.1, §8.2, §8.4, §10.3.

**Files:**
- Create: `patches/0001-linux-platform-dir.patch`, `patches/0002-linux-updater.patch`, `scripts/patch.ts`, `tests/unit/patch.test.ts`

**Interfaces:**
- Consumes: `build/app` and `build/app-pristine` from A5; `src/app/linux-update.js` from A6; `deriveVersions`/`readUpstream`; `run`.
- Produces: `applyPatches(appDir = APP_DIR, pristineDir = APP_PRISTINE_DIR): string[]` (exits 2 on failure), `finishPatchStage()` (copies `linux-update.js`, rewrites `package.json` version, writes `build/patch.json`), `exportPatch(number: string)`.

- [ ] **Step 1: Create the patch files (verbatim; they were generated from the real upstream file and verified to apply in sequence)**

`patches/0001-linux-platform-dir.patch`:
```diff
diff --git a/out/main/index.js b/out/main/index.js
--- a/out/main/index.js
+++ b/out/main/index.js
@@ -36,6 +36,9 @@ function getPlatformDir(platform = os.platform(), arch = os.arch()) {
   if (platform === "win32") {
     return "win-x64";
   }
+  if (platform === "linux") {
+    return arch === "arm64" ? "linux-arm64" : "linux-x64";
+  }
   throw new Error(`Unsupported platform: ${platform}, arch: ${arch}`);
 }
 const resourcesPath = () => utils.is.dev ? `${electron.app.getAppPath()}/resources` : process.resourcesPath;
```

`patches/0002-linux-updater.patch`:
```diff
diff --git a/out/main/index.js b/out/main/index.js
--- a/out/main/index.js
+++ b/out/main/index.js
@@ -12,6 +12,7 @@ const Backend = require("i18next-fs-backend");
 const os = require("os");
 const settings = require("electron-settings");
 const windowStateKeeper = require("electron-window-state");
+const linuxUpdate = require("./linux-update.js");
 const fs$1 = require("fs");
 const sparkMcp = require("@ali/spark-mcp");
 const aes = new AES({
@@ -109,10 +110,20 @@ const initializeAutoUpdater = () => {
     platformSpecificPath = `windows/${process.arch}/`;
   }
   console.log("autoUpdate url", BASE_URL + platformSpecificPath);
-  electronUpdater.autoUpdater.setFeedURL({
-    provider: "generic",
-    url: BASE_URL + platformSpecificPath
-  });
+  if (process.platform === "linux") {
+    electronUpdater.autoUpdater.allowPrerelease = false;
+    electronUpdater.autoUpdater.autoInstallOnAppQuit = !!process.env.APPIMAGE;
+    electronUpdater.autoUpdater.setFeedURL({
+      provider: "github",
+      owner: "sams-git-195",
+      repo: "qwenstudio-linux"
+    });
+  } else {
+    electronUpdater.autoUpdater.setFeedURL({
+      provider: "generic",
+      url: BASE_URL + platformSpecificPath
+    });
+  }
   electronUpdater.autoUpdater.logger = {
     info: () => {
     },
@@ -200,6 +211,10 @@ const checkForUpdates = () => {
     initializeAutoUpdater();
     autoUpdateConfig.notAvailableTip = true;
     console.log("Manual check for updates triggered");
+    if (linuxUpdate.isNotifyOnly()) {
+      linuxUpdate.check({ manual: true, currentVersion: electron.app.getVersion(), dialog: electron.dialog, shell: electron.shell, net: electron.net, t: (k, o) => i18next.t(k, o), icon });
+      return;
+    }
     electronUpdater.autoUpdater.checkForUpdates();
   } catch (error) {
     console.error("Failed to check for updates:", error);
@@ -212,6 +227,10 @@ const checkForUpdates = () => {
 };
 const autoUpdate = () => {
   initializeAutoUpdater();
+  if (linuxUpdate.isNotifyOnly()) {
+    linuxUpdate.check({ manual: false, currentVersion: electron.app.getVersion(), dialog: electron.dialog, shell: electron.shell, net: electron.net, t: (k, o) => i18next.t(k, o), icon });
+    return;
+  }
   electronUpdater.autoUpdater.checkForUpdates();
 };
 const buildAppMenu = () => {
```

Ensure each patch file ends with a single newline and that context lines begin with exactly one space.

- [ ] **Step 2: Write the failing test**

`tests/unit/patch.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyPatches } from "../../scripts/patch.js";

describe("patches", () => {
  it("apply in sequence to the pristine upstream fixture", () => {
    const pristine = path.resolve("tests/fixtures/app-pristine");
    const work = mkdtempSync(path.join(os.tmpdir(), "qs-patch-"));
    cpSync(pristine, work, { recursive: true });
    const applied = applyPatches(work, pristine);
    expect(applied).toEqual(readdirSync("patches").filter((f) => f.endsWith(".patch")).sort());
    const js = readFileSync(path.join(work, "out/main/index.js"), "utf8");
    expect(js).toContain('return arch === "arm64" ? "linux-arm64" : "linux-x64";');
    expect(js).toContain('require("./linux-update.js")');
    expect(js).toContain("allowPrerelease = false");
    expect(js).toContain("autoInstallOnAppQuit = !!process.env.APPIMAGE");
    expect((js.match(/linuxUpdate\.isNotifyOnly\(\)/g) ?? []).length).toBe(2);
  });
  it("git apply --check rejects the patches against an already-patched tree", () => {
    const pristine = path.resolve("tests/fixtures/app-pristine");
    const work = mkdtempSync(path.join(os.tmpdir(), "qs-patch-"));
    cpSync(pristine, work, { recursive: true });
    applyPatches(work, pristine);
    expect(() => execFileSync("git", ["apply", "--check", path.resolve("patches/0001-linux-platform-dir.patch")], { cwd: work, stdio: "pipe" })).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/patch.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/patch.js'`.

- [ ] **Step 4: Implement `scripts/patch.ts`**

```ts
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

function gitApply(patchFile: string, cwd: string, check: boolean): void {
  run("git", ["apply", ...(check ? ["--check"] : []), "--whitespace=nowarn", patchFile], { cwd, capture: true });
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
```

- [ ] **Step 5: Run tests and the real stage**

Run: `npx vitest run tests/unit/patch.test.ts && npm run typecheck && npm run extract && npm run patch && grep -c 'linux-x64' build/app/out/main/index.js && node -e 'console.log(require("./build/app/package.json").version)' && ls build/app/out/main/linux-update.js && cat build/patch.json`
Expected: tests PASS; `applied 2 patch(es): 0001-linux-platform-dir.patch, 0002-linux-updater.patch`; grep prints `1`; version `1.0.3-44.1`; `patch.json` lists both patches.

- [ ] **Step 6: Verify the export round-trip is stable**

Run: `npm run patches:export -- 0002 && git diff --stat -- patches/`
Expected: `git diff` shows no change (or only the removed `index` header line if the executor typed one). If a difference other than the header appears, inspect and fix the patch file so the round-trip is stable.

- [ ] **Step 7: Commit**

```bash
git add patches/0001-linux-platform-dir.patch patches/0002-linux-updater.patch scripts/patch.ts tests/unit/patch.test.ts
git commit -m "feat: add Linux patches and the patch stage" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A8: `assemble.ts` and `icons.ts`

**Spec:** §10.4, §10.5.

**Files:**
- Create: `scripts/assemble.ts`, `scripts/icons.ts`, `tests/unit/icons.test.ts`

**Interfaces:**
- Consumes: `build/app`, `build/electron`, `build/bun`, `build/uv`, `build/win-app` from A5/A7; `readSidecars`; `run`.
- Produces: `assemble(): Promise<void>` → `build/linux-unpacked/`; `renderIcons(src: string, outDir: string): Promise<number[]>` → `build/icons/<N>x<N>.png`; `ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]`.

- [ ] **Step 1: Write the failing icons test**

`tests/unit/icons.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { renderIcons, ICON_SIZES } from "../../scripts/icons.js";

describe("renderIcons", () => {
  it("renders every hicolor size from a square source", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qs-icons-"));
    const src = path.join(dir, "icon.png");
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toFile(src);
    const out = path.join(dir, "out");
    expect(await renderIcons(src, out)).toEqual(ICON_SIZES);
    expect(readdirSync(out).sort()).toEqual(ICON_SIZES.map((n) => `${n}x${n}.png`).sort());
    const meta = await sharp(path.join(out, "512x512.png")).metadata();
    expect([meta.width, meta.height]).toEqual([512, 512]);
  });
  it("rejects a non-square source", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qs-icons-"));
    const src = path.join(dir, "wide.png");
    await sharp({ create: { width: 200, height: 100, channels: 4, background: "#fff" } }).png().toFile(src);
    await expect(renderIcons(src, path.join(dir, "out"))).rejects.toThrow(/square/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/icons.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/icons.js'`.

- [ ] **Step 3: Implement `scripts/icons.ts`**

```ts
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { ICONS_DIR, WIN_APP_DIR } from "./lib/paths.js";

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

export async function renderIcons(src: string, outDir: string): Promise<number[]> {
  const meta = await sharp(src).metadata();
  if (!meta.width || !meta.height || meta.width !== meta.height) throw new Error(`icon source must be square, got ${meta.width}x${meta.height}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const n of ICON_SIZES) await sharp(src).resize(n, n, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(outDir, `${n}x${n}.png`));
  return ICON_SIZES;
}

export async function main(): Promise<void> {
  const sizes = await renderIcons(path.join(WIN_APP_DIR, "resources", "assets", "icon.png"), ICONS_DIR);
  console.log(`rendered icons: ${sizes.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Implement `scripts/assemble.ts`**

```ts
import { rmSync, mkdirSync, cpSync, renameSync, chmodSync, existsSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import asar from "@electron/asar";
import { readSidecars, readUpstream } from "./lib/manifest.js";
import { deriveVersions } from "./lib/versions.js";
import { run } from "./lib/exec.js";
import { APP_DIR, ELECTRON_DIR, BUN_DIR, UV_DIR, WIN_APP_DIR, UNPACKED_DIR } from "./lib/paths.js";

const EXECUTABLES = ["qwen-studio", "chrome-sandbox", "chrome_crashpad_handler", "resources/bun/bun", "resources/python/uv", "resources/python/uvx"];

function assert(cond: unknown, msg: string): asserts cond { if (!cond) { console.error(`assemble: ${msg}`); process.exit(5); } }

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
  mkdirSync(path.join(res, "bun")); mkdirSync(path.join(res, "python"));
  copyFileSync(path.join(BUN_DIR, sc.bun.extract!.bun), path.join(res, "bun", "bun"));
  copyFileSync(path.join(UV_DIR, sc.uv.extract!.uv), path.join(res, "python", "uv"));
  copyFileSync(path.join(UV_DIR, sc.uv.extract!.uvx), path.join(res, "python", "uvx"));
  for (const f of EXECUTABLES) chmodSync(path.join(UNPACKED_DIR, f), 0o755);

  // Post-conditions (spec §10.4)
  assert(existsSync(path.join(UNPACKED_DIR, "qwen-studio")), "qwen-studio missing");
  assert(!existsSync(path.join(res, "default_app.asar")), "default_app.asar still present");
  for (const f of ["elevate.exe", "app-update.yml", "bun/bun.exe", "python/uv.exe", "python/uvx.exe"]) assert(!existsSync(path.join(res, f)), `${f} must not be shipped`);
  assert(readdirSync(path.join(res, "i18n")).filter((f) => f.endsWith(".json")).length === 12, "expected 12 i18n files");
  const files = asar.listPackage(path.join(res, "app.asar"));
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
```

- [ ] **Step 5: Run tests and the real stages**

Run: `npx vitest run tests/unit/icons.test.ts && npm run typecheck && npm run assemble && npm run icons && ls build/linux-unpacked/resources build/icons`
Expected: tests PASS; `assembled ... (app 1.0.3-44.1, electron 35.1.4)`; `rendered icons: 16, 24, ...`; `resources` lists `app.asar assets bun i18n python`.

- [ ] **Step 6: Launch the assembled tree locally (the spike assertion)**

Run:
```bash
HOME=$(mktemp -d) build/linux-unpacked/qwen-studio --remote-debugging-port=9333 > /tmp/qs-launch.log 2>&1 &
sleep 8; curl -s http://127.0.0.1:9333/json | grep -o '"type": *"[a-z]*"\|"url": *"[^"]*"' ; grep -c 'Unsupported platform' /tmp/qs-launch.log; kill %1
```
Expected: a `"type": "page"` with url ending `out/renderer/index.html` and a `"type": "webview"` with url starting `https://chat.qwen.ai`; grep prints `0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/assemble.ts scripts/icons.ts tests/unit/icons.test.ts
git commit -m "feat: assemble the Linux unpacked tree and render hicolor icons" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A9: `build.ts` orchestrator (stages fetch → icons)

**Spec:** §10.6 (stage ordering), §8.4 (`patches:dev`).

**Files:**
- Create: `scripts/build.ts`, `tests/unit/build-stages.test.ts`

**Interfaces:**
- Consumes: `fetchAll` (A4), `extractAll` (A5), `applyPatches`+`finishPatchStage` (A7), `assemble` (A8), `renderIcons` (A8), `writeVersionJson` (A3).
- Produces: `STAGES` = `["fetch","extract","patch","assemble","icons"]` (Task B2 appends `"package"`); `selectStages(until?: string): Stage[]`; `runStages(until?: string): Promise<void>`; CLI `npm run build [-- --until <stage>]`.

- [ ] **Step 1: Write the failing test**

`tests/unit/build-stages.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { STAGES, selectStages } from "../../scripts/build.js";

describe("build stages", () => {
  it("has the documented order", () => {
    expect(STAGES).toEqual(["fetch", "extract", "patch", "assemble", "icons"]);
  });
  it("selects a prefix with --until", () => {
    expect(selectStages("patch")).toEqual(["fetch", "extract", "patch"]);
    expect(selectStages(undefined)).toEqual(STAGES);
    expect(() => selectStages("nope")).toThrow(/Unknown stage/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/build-stages.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/build.js'`.

- [ ] **Step 3: Implement `scripts/build.ts`**

```ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeVersionJson } from "./version.js";
import { fetchAll } from "./fetch.js";
import { extractAll } from "./extract.js";
import { applyPatches, finishPatchStage } from "./patch.js";
import { assemble } from "./assemble.js";
import { renderIcons } from "./icons.js";
import { ICONS_DIR, WIN_APP_DIR } from "./lib/paths.js";

export const STAGES = ["fetch", "extract", "patch", "assemble", "icons"] as const;
export type Stage = (typeof STAGES)[number];

export function selectStages(until: string | undefined): Stage[] {
  if (until === undefined) return [...STAGES];
  const i = STAGES.indexOf(until as Stage);
  if (i === -1) throw new Error(`Unknown stage "${until}"; expected one of ${STAGES.join(", ")}`);
  return STAGES.slice(0, i + 1) as Stage[];
}

const impl: Record<Stage, () => Promise<void>> = {
  fetch: async () => { await fetchAll(); },
  extract: extractAll,
  patch: async () => { applyPatches(); finishPatchStage(); },
  assemble,
  icons: async () => { await renderIcons(path.join(WIN_APP_DIR, "resources", "assets", "icon.png"), ICONS_DIR); },
};

export async function runStages(until?: string): Promise<void> {
  const v = writeVersionJson();
  console.log(`== building Qwen Studio ${v.appVersion} (tag ${v.gitTag})`);
  for (const s of selectStages(until)) {
    const t0 = Date.now();
    console.log(`== stage: ${s}`);
    await impl[s]();
    console.log(`== stage ${s} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const i = argv.indexOf("--until");
  await runStages(i === -1 ? undefined : argv[i + 1]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run tests and an end-to-end run up to icons**

Run: `npx vitest run tests/unit/build-stages.test.ts && npm run typecheck && npm run build -- --until icons && npm run patches:dev`
Expected: tests PASS; the build prints five `== stage:` lines ending with `icons`; `patches:dev` stops after `patch`.

- [ ] **Step 5: Commit**

```bash
git add scripts/build.ts tests/unit/build-stages.test.ts
git commit -m "feat: add the build orchestrator with --until stage selection" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Workstream B — Packaging

### Task B1: electron-builder base config and config generator

**Spec:** §10.7.

**Files:**
- Create: `packaging/electron-builder.base.json`, `scripts/lib/electron-builder-config.ts`, `tests/unit/electron-builder-config.test.ts`

**Interfaces:**
- Consumes: `DerivedVersions` (A3), `run` (A4), `UNPACKED_DIR`, `BUILD_DIR`, `DIST_DIR` (A2).
- Produces: `type Target = "AppImage" | "deb" | "rpm"`; `TARGETS`; `buildConfig(target: Target, v: DerivedVersions): Record<string, unknown>`; `packageTarget(target: Target, v: DerivedVersions): void`; `packageAll(): Promise<void>`.

- [ ] **Step 1: Create `packaging/electron-builder.base.json`**

```json
{
  "appId": "ai.qwen.studio",
  "productName": "Qwen Studio",
  "executableName": "qwen-studio",
  "electronVersion": "35.1.4",
  "directories": { "buildResources": "packaging", "output": "dist" },
  "publish": [{ "provider": "github", "owner": "sams-git-195", "repo": "qwenstudio-linux" }],
  "linux": {
    "target": [],
    "category": "Network",
    "synopsis": "Desktop client for Qwen Chat (unofficial Linux packaging)",
    "description": "Unofficial Linux packaging of Qwen Studio, Alibaba's desktop client for chat.qwen.ai. Not affiliated with Alibaba Cloud.",
    "maintainer": "sams-git-195 <samheard95@gmail.com>",
    "vendor": "sams-git-195 (unofficial)",
    "icon": "build/icons",
    "executableArgs": ["--ozone-platform-hint=auto"],
    "protocols": [{ "name": "Qwen", "schemes": ["qwen"] }],
    "desktop": {
      "entry": {
        "Name": "Qwen Studio",
        "Comment": "Chat with Qwen",
        "Categories": "Network;Chat;",
        "StartupWMClass": "Qwen Studio",
        "MimeType": "x-scheme-handler/qwen;"
      }
    }
  },
  "deb": {
    "packageCategory": "net",
    "priority": "optional",
    "depends": [
      "libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0",
      "libasound2", "libdrm2", "libgbm1", "libxkbcommon0", "libatk-bridge2.0-0", "libatk1.0-0", "libcups2", "libdbus-1-3",
      "libexpat1", "libx11-6", "libxcomposite1", "libxdamage1", "libxext6", "libxfixes3", "libxrandr6", "libpango-1.0-0",
      "libcairo2", "libglib2.0-0", "libnspr4", "libxcb1", "libgcc-s1", "libstdc++6", "libc6"
    ],
    "recommends": ["libappindicator3-1"]
  },
  "rpm": {
    "depends": [
      "gtk3", "libnotify", "nss", "libXScrnSaver", "libXtst", "xdg-utils", "at-spi2-core", "libuuid", "libsecret",
      "alsa-lib", "libdrm", "mesa-libgbm", "libxkbcommon", "at-spi2-atk", "atk", "cups-libs", "dbus-libs", "expat",
      "libX11", "libXcomposite", "libXdamage", "libXext", "libXfixes", "libXrandr", "pango", "cairo", "glib2", "nspr",
      "libxcb", "libgcc", "libstdc++"
    ]
  },
  "appImage": {}
}
```

- [ ] **Step 2: Write the failing test**

`tests/unit/electron-builder-config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildConfig, TARGETS } from "../../scripts/lib/electron-builder-config.js";
import { deriveVersions } from "../../scripts/lib/versions.js";

const v = deriveVersions({ version: "1.0.3", build: 44, wrapper_revision: 1 });

describe("buildConfig", () => {
  it("lists the three targets", () => expect(TARGETS).toEqual(["AppImage", "deb", "rpm"]));
  it("generates the deb config", () => {
    const c = buildConfig("deb", v) as Record<string, any>;
    expect(c.linux.target).toEqual(["deb"]);
    expect(c.directories).toEqual({ buildResources: "packaging", output: "dist/deb" });
    expect(c.extraMetadata).toEqual({ name: "qwen-studio", version: "1.0.3-44.1", description: c.linux.description, homepage: "https://github.com/sams-git-195/qwenstudio-linux" });
    expect(c.deb.artifactName).toBe("qwen-studio_1.0.3.44-1_amd64.deb");
    expect(c.deb.fpm).toEqual(["--version", "1.0.3.44", "--iteration", "1"]);
    expect(c.linux.executableArgs).toEqual(["--ozone-platform-hint=auto"]);
    expect(c.deb.depends).toContain("libasound2");
  });
  it("generates the rpm config", () => {
    const c = buildConfig("rpm", v) as Record<string, any>;
    expect(c.rpm.artifactName).toBe("qwen-studio-1.0.3.44-1.x86_64.rpm");
    expect(c.rpm.fpm).toEqual(["--version", "1.0.3.44", "--iteration", "1"]);
    expect(c.directories.output).toBe("dist/rpm");
  });
  it("generates the AppImage config", () => {
    const c = buildConfig("AppImage", v) as Record<string, any>;
    expect(c.appImage.artifactName).toBe("qwen-studio-1.0.3.44-1-x86_64.AppImage");
    expect(c.directories.output).toBe("dist/appimage");
    expect(c.linux.target).toEqual(["AppImage"]);
  });
  it("does not mutate the base between calls", () => {
    buildConfig("deb", v);
    const c = buildConfig("rpm", v) as Record<string, any>;
    expect(c.deb.artifactName).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/electron-builder-config.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/lib/electron-builder-config.js'`.

- [ ] **Step 4: Implement `scripts/lib/electron-builder-config.ts`**

```ts
import { readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, renameSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { readUpstream } from "./manifest.js";
import { deriveVersions, type DerivedVersions } from "./versions.js";
import { ROOT, BUILD_DIR, DIST_DIR, UNPACKED_DIR, CACHE_DIR } from "./paths.js";

export type Target = "AppImage" | "deb" | "rpm";
export const TARGETS: Target[] = ["AppImage", "deb", "rpm"];
export const HOMEPAGE = "https://github.com/sams-git-195/qwenstudio-linux";

export function buildConfig(target: Target, v: DerivedVersions): Record<string, unknown> {
  const base = JSON.parse(readFileSync(path.join(ROOT, "packaging", "electron-builder.base.json"), "utf8"));
  const cfg = structuredClone(base) as Record<string, any>;
  const dir = target.toLowerCase();
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/electron-builder-config.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packaging/electron-builder.base.json scripts/lib/electron-builder-config.ts tests/unit/electron-builder-config.test.ts
git commit -m "feat: add electron-builder configuration generator" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task B2: `package` stage and the first full build

**Spec:** §10.6.

**Files:**
- Modify: `scripts/build.ts` (STAGES and `impl`), `tests/unit/build-stages.test.ts`

Prerequisites on the dev host: `sudo dnf install -y rpm-build dpkg` (rpmbuild is needed by fpm for the rpm target; `dpkg-deb` is used by B3).

- [ ] **Step 1: Update the test**

In `tests/unit/build-stages.test.ts` change the two expectations:
```ts
    expect(STAGES).toEqual(["fetch", "extract", "patch", "assemble", "icons", "package"]);
```
and
```ts
    expect(selectStages("patch")).toEqual(["fetch", "extract", "patch"]);
    expect(selectStages("icons")).toEqual(["fetch", "extract", "patch", "assemble", "icons"]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/build-stages.test.ts`
Expected: FAIL on the `STAGES` equality.

- [ ] **Step 3: Modify `scripts/build.ts`**

Replace the `STAGES` line and the `impl` map with:
```ts
import { packageAll } from "./lib/electron-builder-config.js";

export const STAGES = ["fetch", "extract", "patch", "assemble", "icons", "package"] as const;
```
(the `import` goes with the other imports at the top) and add to `impl`:
```ts
  package: packageAll,
```

- [ ] **Step 4: Run tests and the full build**

Run: `npx vitest run tests/unit/build-stages.test.ts && npm run typecheck && npm run build 2>&1 | tail -30 && ls -la dist/`
Expected: `dist/` contains exactly `latest-linux.yml`, `qwen-studio-1.0.3.44-1-x86_64.AppImage`, `qwen-studio-1.0.3.44-1.x86_64.rpm`, `qwen-studio_1.0.3.44-1_amd64.deb`. If electron-builder fails with a message about `package.json` `main` or missing `electron` devDependency, add `"main": "scripts/build.ts"` to `package.json` (harmless; electron-builder only checks presence for prepackaged builds) and re-run; record the change in the commit body.

- [ ] **Step 5: Verify the version overrides took effect**

Run:
```bash
dpkg-deb -f dist/qwen-studio_1.0.3.44-1_amd64.deb Package Version
rpm -qp --qf '%{NAME} %{VERSION} %{RELEASE}\n' dist/qwen-studio-1.0.3.44-1.x86_64.rpm
grep -E '^(version|path):' dist/latest-linux.yml
```
Expected: `Package: qwen-studio` / `Version: 1.0.3.44-1`; `qwen-studio 1.0.3.44 1`; `version: 1.0.3-44.1` and `path: qwen-studio-1.0.3.44-1-x86_64.AppImage`. If the deb Version prints `1.0.3~44.1` instead, fpm did not honour the later `--version` override: stop, do not commit, and report to the user with the exact output (the spec fixes the deb/rpm version strings; changing the scheme is not an option for this task).

- [ ] **Step 6: Commit**

```bash
git add scripts/build.ts tests/unit/build-stages.test.ts package.json
git commit -m "feat: add the package stage building AppImage, deb and rpm" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task B3: `verify.ts` artifact assertions

**Spec:** §10.8.

**Files:**
- Create: `scripts/verify.ts`, `tests/unit/verify-helpers.test.ts`

**Interfaces:**
- Consumes: `dist/*` from B2; `deriveVersions`; `run`; `sha512Base64File`.
- Produces: `parseDesktopEntry(text): Record<string,string>`, `assertDesktop(entry, execRegex): void`, `verifyAll(): Promise<void>`; CLI `npm run verify` exits 6 on any failed assertion, printing every failure.

Host tools: `dpkg-deb`, `rpm`, `rpm2cpio`, `cpio`, `desktop-file-validate`.

- [ ] **Step 1: Write the failing test**

`tests/unit/verify-helpers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseDesktopEntry, assertDesktop, DEB_EXEC_RE, APPIMAGE_EXEC_RE } from "../../scripts/verify.js";

const deb = `[Desktop Entry]
Name=Qwen Studio
Exec="/opt/Qwen Studio/qwen-studio" --ozone-platform-hint=auto %U
Terminal=false
Type=Application
Icon=qwen-studio
StartupWMClass=Qwen Studio
Comment=Chat with Qwen
MimeType=x-scheme-handler/qwen;
Categories=Network;Chat;
`;

describe("desktop entry helpers", () => {
  it("parses key/value lines", () => {
    expect(parseDesktopEntry(deb).Exec).toBe('"/opt/Qwen Studio/qwen-studio" --ozone-platform-hint=auto %U');
    expect(parseDesktopEntry(deb).Categories).toBe("Network;Chat;");
  });
  it("accepts a correct deb entry and the AppImage variant", () => {
    expect(() => assertDesktop(parseDesktopEntry(deb), DEB_EXEC_RE)).not.toThrow();
    expect(() => assertDesktop(parseDesktopEntry(deb.replace(/^Exec=.*$/m, "Exec=AppRun --ozone-platform-hint=auto %U")), APPIMAGE_EXEC_RE)).not.toThrow();
  });
  it("rejects a missing ozone flag or mime type", () => {
    expect(() => assertDesktop(parseDesktopEntry(deb.replace(" --ozone-platform-hint=auto", "")), DEB_EXEC_RE)).toThrow(/Exec/);
    expect(() => assertDesktop(parseDesktopEntry(deb.replace("MimeType=x-scheme-handler/qwen;\n", "")), DEB_EXEC_RE)).toThrow(/MimeType/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/verify-helpers.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/verify.js'`.

- [ ] **Step 3: Implement `scripts/verify.ts`**

```ts
import { readdirSync, readFileSync, statSync, existsSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import asar from "@electron/asar";
import { run } from "./lib/exec.js";
import { readUpstream } from "./lib/manifest.js";
import { deriveVersions } from "./lib/versions.js";
import { sha512Base64File } from "./lib/hash.js";
import { DIST_DIR, BUILD_DIR } from "./lib/paths.js";

export const DEB_EXEC_RE = /^"?\/opt\/Qwen Studio\/qwen-studio"? --ozone-platform-hint=auto %U$/;
export const APPIMAGE_EXEC_RE = /^AppRun --ozone-platform-hint=auto %U$/;

export function parseDesktopEntry(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) { const m = /^([A-Za-z0-9-]+)=(.*)$/.exec(line); if (m) out[m[1]] = m[2]; }
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
  try { fn(); console.log(`ok   ${label}`); } catch (e) { failures.push(`${label}: ${(e as Error).message}`); console.log(`FAIL ${label}: ${(e as Error).message}`); }
}
function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const REQUIRED_PATHS = [
  "opt/Qwen Studio/qwen-studio", "opt/Qwen Studio/resources/bun/bun", "opt/Qwen Studio/resources/python/uvx",
  "usr/share/applications/qwen-studio.desktop", "usr/share/icons/hicolor/512x512/apps/qwen-studio.png",
];

export async function verifyAll(): Promise<void> {
  const v = deriveVersions(readUpstream());
  const deb = path.join(DIST_DIR, v.artifacts.deb); const rpm = path.join(DIST_DIR, v.artifacts.rpm); const app = path.join(DIST_DIR, v.artifacts.appImage);
  const ymlPath = path.join(DIST_DIR, "latest-linux.yml");
  const work = path.join(BUILD_DIR, "verify"); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });

  check("dist contains exactly the four expected files", () => {
    eq(readdirSync(DIST_DIR).sort().join(","), [v.artifacts.appImage, v.artifacts.rpm, v.artifacts.deb, "latest-linux.yml"].sort().join(","), "dist listing");
  });
  check("deb control fields", () => {
    eq(run("dpkg-deb", ["-f", deb, "Version"], { capture: true }).trim(), v.debVersion, "deb Version");
    eq(run("dpkg-deb", ["-f", deb, "Package"], { capture: true }).trim(), "qwen-studio", "deb Package");
    eq(run("dpkg-deb", ["-f", deb, "Architecture"], { capture: true }).trim(), "amd64", "deb Architecture");
  });
  check("deb payload paths", () => {
    const list = run("dpkg-deb", ["-c", deb], { capture: true });
    for (const p of REQUIRED_PATHS) if (!list.includes(`./${p}`)) throw new Error(`missing ./${p}`);
  });
  check("deb desktop entry and asar version", () => {
    const x = path.join(work, "deb"); mkdirSync(x); run("dpkg-deb", ["-x", deb, x]);
    const desktop = path.join(x, "usr/share/applications/qwen-studio.desktop");
    assertDesktop(parseDesktopEntry(readFileSync(desktop, "utf8")), DEB_EXEC_RE);
    run("desktop-file-validate", [desktop]);
    const pkg = JSON.parse(asar.extractFile(path.join(x, "opt/Qwen Studio/resources/app.asar"), "package.json").toString("utf8")) as { version: string };
    eq(pkg.version, v.appVersion, "asar package.json version");
  });
  check("rpm header fields and payload", () => {
    eq(run("rpm", ["-qp", "--qf", "%{NAME} %{VERSION} %{RELEASE} %{ARCH}", rpm], { capture: true }).trim(), `qwen-studio ${v.rpmVersion} ${v.rpmRelease} x86_64`, "rpm NVR");
    const list = run("rpm", ["-qpl", rpm], { capture: true });
    for (const p of REQUIRED_PATHS) if (!list.includes(`/${p}`)) throw new Error(`missing /${p}`);
  });
  check("rpm desktop entry", () => {
    const x = path.join(work, "rpm"); mkdirSync(x);
    run("bash", ["-c", `rpm2cpio "${rpm}" | cpio -idm --quiet`], { cwd: x });
    const desktop = path.join(x, "usr/share/applications/qwen-studio.desktop");
    assertDesktop(parseDesktopEntry(readFileSync(desktop, "utf8")), DEB_EXEC_RE);
    run("desktop-file-validate", [desktop]);
  });
  check("AppImage extracts, has no package-type, desktop entry correct", () => {
    if (!(statSync(app).mode & 0o111)) throw new Error("AppImage not executable");
    const x = path.join(work, "appimage"); mkdirSync(x);
    run(app, ["--appimage-extract"], { cwd: x });
    const root = path.join(x, "squashfs-root");
    if (existsSync(path.join(root, "resources/package-type"))) throw new Error("resources/package-type must not exist in the AppImage");
    if (!existsSync(path.join(root, "resources/bun/bun"))) throw new Error("resources/bun/bun missing");
    const desktop = path.join(root, "qwen-studio.desktop");
    assertDesktop(parseDesktopEntry(readFileSync(desktop, "utf8")), APPIMAGE_EXEC_RE);
    run("desktop-file-validate", [desktop]);
  });
  await (async () => {
    try {
      const y = yaml.load(readFileSync(ymlPath, "utf8")) as { version: string; path: string; sha512: string; size: number; files: Array<{ url: string; sha512: string; size: number }> };
      eq(y.version, v.appVersion, "latest-linux.yml version");
      eq(y.path, v.artifacts.appImage, "latest-linux.yml path");
      eq(y.files[0].url, v.artifacts.appImage, "latest-linux.yml files[0].url");
      eq(y.sha512, await sha512Base64File(app), "latest-linux.yml sha512");
      eq(y.size, statSync(app).size, "latest-linux.yml size");
      console.log("ok   latest-linux.yml matches the AppImage");
    } catch (e) { failures.push(`latest-linux.yml: ${(e as Error).message}`); console.log(`FAIL latest-linux.yml: ${(e as Error).message}`); }
  })();

  if (failures.length) { console.error(`\n${failures.length} verification failure(s):\n- ${failures.join("\n- ")}`); process.exit(6); }
  console.log("\nall artifact verifications passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) verifyAll();
```

- [ ] **Step 4: Run tests and verify the real artifacts**

Run: `npx vitest run tests/unit/verify-helpers.test.ts && npm run typecheck && npm run verify`
Expected: unit PASS; `npm run verify` prints `ok` for every check and `all artifact verifications passed`. If the deb/rpm `Exec=` line differs only in quoting from `DEB_EXEC_RE`, adjust the regex to match electron-builder's actual output and update the unit test fixture to the same string (the flag and `%U` must still be required).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify.ts tests/unit/verify-helpers.test.ts
git commit -m "feat: add artifact verification stage" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task B4: Dependency list validation against `ldd`

**Spec:** §10.7 (`deps.test.ts`).

**Files:**
- Create: `tests/fixtures/soname-to-deb.json`, `tests/unit/deps.test.ts`

- [ ] **Step 1: Capture the real ldd output**

Run: `ldd build/linux-unpacked/qwen-studio | awk '/=>/ {print $1}' | sort`
Expected: a list of sonames such as `libasound.so.2`, `libatk-1.0.so.0`, ..., `libxkbcommon.so.0`. Keep this output for Step 2.

- [ ] **Step 2: Create the soname table**

`tests/fixtures/soname-to-deb.json` — one entry per soname from Step 1 that is **not** shipped inside `build/linux-unpacked/` (bundled ones like `libffmpeg.so`, `libEGL.so`, `libGLESv2.so`, `libvk_swiftshader.so`, `libvulkan.so.1` are skipped by the test). Start from this table and add any soname the test reports as unmapped:
```json
{
  "libasound.so.2": "libasound2",
  "libatk-1.0.so.0": "libatk1.0-0",
  "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0",
  "libatspi.so.0": "libatspi2.0-0",
  "libc.so.6": "libc6",
  "libcairo.so.2": "libcairo2",
  "libcups.so.2": "libcups2",
  "libdbus-1.so.3": "libdbus-1-3",
  "libdl.so.2": "libc6",
  "libdrm.so.2": "libdrm2",
  "libexpat.so.1": "libexpat1",
  "libgbm.so.1": "libgbm1",
  "libgcc_s.so.1": "libgcc-s1",
  "libgio-2.0.so.0": "libglib2.0-0",
  "libglib-2.0.so.0": "libglib2.0-0",
  "libgobject-2.0.so.0": "libglib2.0-0",
  "libgmodule-2.0.so.0": "libglib2.0-0",
  "libm.so.6": "libc6",
  "libnspr4.so": "libnspr4",
  "libnss3.so": "libnss3",
  "libnssutil3.so": "libnss3",
  "libpango-1.0.so.0": "libpango-1.0-0",
  "libpthread.so.0": "libc6",
  "librt.so.1": "libc6",
  "libsmime3.so": "libnss3",
  "libstdc++.so.6": "libstdc++6",
  "libX11.so.6": "libx11-6",
  "libxcb.so.1": "libxcb1",
  "libXcomposite.so.1": "libxcomposite1",
  "libXdamage.so.1": "libxdamage1",
  "libXext.so.6": "libxext6",
  "libXfixes.so.3": "libxfixes3",
  "libxkbcommon.so.0": "libxkbcommon0",
  "libXrandr.so.2": "libxrandr6"
}
```

- [ ] **Step 3: Write the test**

`tests/unit/deps.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const exe = "build/linux-unpacked/qwen-studio";
const base = JSON.parse(readFileSync("packaging/electron-builder.base.json", "utf8"));
const table: Record<string, string> = JSON.parse(readFileSync("tests/fixtures/soname-to-deb.json", "utf8"));

describe.skipIf(!existsSync(exe))("deb depends cover ldd of the Electron binary (needs build/linux-unpacked)", () => {
  it("every runtime soname maps to a declared deb dependency", () => {
    const out = execFileSync("ldd", [exe], { encoding: "utf8" });
    const sonames = out.split("\n").filter((l) => l.includes("=>")).map((l) => l.trim().split(/\s+/)[0]);
    const unmapped: string[] = []; const undeclared: string[] = [];
    for (const so of sonames) {
      if (existsSync(`build/linux-unpacked/${so}`)) continue; // bundled with Electron
      const pkg = table[so];
      if (!pkg) { unmapped.push(so); continue; }
      if (!base.deb.depends.includes(pkg)) undeclared.push(`${so} -> ${pkg}`);
    }
    expect(unmapped, "add these sonames to tests/fixtures/soname-to-deb.json").toEqual([]);
    expect(undeclared, "add these packages to deb.depends in packaging/electron-builder.base.json").toEqual([]);
  });
});

describe("dependency lists are well-formed", () => {
  it("contain electron-builder's defaults", () => {
    for (const p of ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0"]) expect(base.deb.depends).toContain(p);
    for (const p of ["gtk3", "libnotify", "nss", "libXScrnSaver", "libXtst", "xdg-utils", "at-spi2-core", "libuuid", "libsecret"]) expect(base.rpm.depends).toContain(p);
  });
  it("have no duplicates", () => {
    expect(new Set(base.deb.depends).size).toBe(base.deb.depends.length);
    expect(new Set(base.rpm.depends).size).toBe(base.rpm.depends.length);
  });
});
```

- [ ] **Step 4: Run the test; iterate the table until green**

Run: `npx vitest run tests/unit/deps.test.ts`
Expected: PASS. If it reports unmapped sonames, add them to the table (Debian/Ubuntu 22.04 package that ships that soname: `apt-file search <soname>` inside a `ubuntu:22.04` container, or https://packages.ubuntu.com/). If it reports undeclared packages, add them to **both** `deb.depends` and the rpm equivalent in `packaging/electron-builder.base.json`.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/soname-to-deb.json tests/unit/deps.test.ts packaging/electron-builder.base.json
git commit -m "test: validate deb dependencies against ldd of the Electron binary" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task B5: lintian and rpmlint configuration

**Spec:** §11.3.

**Files:**
- Create: `packaging/lintian/qwen-studio.overrides`, `packaging/rpmlint/qwen-studio.toml`

Requires Docker or Podman on the dev host (`docker` below; `podman` accepts the same arguments).

- [ ] **Step 1: Run lintian on the real deb (first pass, no overrides)**

Run:
```bash
docker run --rm -v "$PWD/dist:/dist:ro" debian:12 bash -c \
 'apt-get update -qq && apt-get install -y -qq lintian >/dev/null && lintian --no-tag-display-limit /dist/qwen-studio_1.0.3.44-1_amd64.deb; echo "exit=$?"'
```
Expected: a list of `E:`/`W:` lines. Record every `E:` tag name.

- [ ] **Step 2: Create `packaging/lintian/qwen-studio.overrides`**

Apply the spec rule: suppress an `E:` tag only if it is caused by the verbatim Electron/upstream payload; fix anything about the desktop file, control fields, dependencies, maintainer scripts or permissions in `packaging/electron-builder.base.json` instead. Starting content (remove lines whose tags did not appear; add lines for payload-caused tags that did, each with a justification comment):
```
# Electron ships its own copies of ffmpeg, EGL/GLES, SwiftShader and Vulkan loaders; they cannot be unbundled.
embedded-library
# Prebuilt Electron binaries and the bun/uv sidecars are not stripped upstream; stripping would break Electron's crash reporting symbols.
unstripped-binary-or-object
# electron-builder installs to /opt/<productName>; this layout is required by the auto-updater and the upstream code.
dir-or-file-in-opt
# The Electron binary carries an $ORIGIN rpath to find its bundled libraries in /opt.
binary-or-shlib-defines-rpath
# Bundled Electron shared objects resolve their prerequisites via rpath, not via dpkg shlibs.
shared-library-lacks-prerequisites
# The bun and uv sidecars are statically linked upstream binaries.
statically-linked-binary
```

- [ ] **Step 3: Re-run lintian with the overrides and `--fail-on error`**

Run:
```bash
docker run --rm -v "$PWD/dist:/dist:ro" -v "$PWD/packaging:/packaging:ro" debian:12 bash -c \
 'apt-get update -qq && apt-get install -y -qq lintian >/dev/null && lintian --suppress-tags-from-file /packaging/lintian/qwen-studio.overrides --fail-on error --no-tag-display-limit /dist/qwen-studio_1.0.3.44-1_amd64.deb; echo "exit=$?"'
```
Expected: `exit=0`. If an `E:` tag remains that the rule forbids suppressing (desktop/control/deps/scripts/permissions), fix it in `packaging/electron-builder.base.json`, rebuild (`npm run build -- --until package` is not incremental; run `npm run build`), and repeat.

- [ ] **Step 4: Run rpmlint on the real rpm (first pass)**

Run:
```bash
docker run --rm -v "$PWD/dist:/dist:ro" fedora:41 bash -c \
 'dnf install -y -q rpmlint >/dev/null && rpmlint /dist/qwen-studio-1.0.3.44-1.x86_64.rpm; echo "exit=$?"'
```
Expected: a report ending with `N packages and 0 specfiles checked; E errors, W warnings`. Record every `E:` code.

- [ ] **Step 5: Create `packaging/rpmlint/qwen-studio.toml`**

```toml
# rpmlint configuration for the unofficial Qwen Studio package.
# Only findings inherent to the verbatim Electron/upstream payload are filtered (see spec section 11.3).
Filters = [
  # Prebuilt Electron binaries and bun/uv sidecars are not stripped upstream.
  "unstripped-binary-or-object",
  # Electron bundles ffmpeg, EGL/GLES, SwiftShader and Vulkan loaders under /opt.
  "shlib-with-non-pic-code",
  "binary-or-shlib-defines-rpath",
  # electron-builder installs under /opt/<productName>, which is not a standard RPM directory.
  "dir-or-file-in-opt",
  "standard-dir-owned-by-package",
  # The package ships no man page or docs by design; documentation lives in the GitHub repository.
  "no-documentation",
  "no-manual-page-for-binary",
]
```
Remove entries whose codes did not appear; add entries for payload-caused `E:` codes that did, each with a comment.

- [ ] **Step 6: Re-run rpmlint with the config**

Run:
```bash
docker run --rm -v "$PWD/dist:/dist:ro" -v "$PWD/packaging:/packaging:ro" fedora:41 bash -c \
 'dnf install -y -q rpmlint >/dev/null && rpmlint -c /packaging/rpmlint/qwen-studio.toml /dist/qwen-studio-1.0.3.44-1.x86_64.rpm; echo "exit=$?"'
```
Expected: the summary line reports `0 errors`; `exit=0`. rpmlint 2.x with `-c` accepts a file path; if it complains that the config is not a directory, run with `-c /packaging/rpmlint/` instead and note that in `docs/ARCHITECTURE.md` (Task E4).

- [ ] **Step 7: Commit**

```bash
git add packaging/lintian/qwen-studio.overrides packaging/rpmlint/qwen-studio.toml
git commit -m "build: add lintian overrides and rpmlint configuration" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Workstream C — CI test matrix

### Task C1: Headless smoke test `tests/smoke/smoke.sh`

**Spec:** §11.5, §3.5.

**Files:**
- Create: `tests/smoke/smoke.sh`

**Interfaces:**
- Produces: `tests/smoke/smoke.sh <executable> <resources-dir>`; env `SMOKE_PORT` (default 9333), `SMOKE_LOG` (default `$PWD/smoke.log`), `SMOKE_KEEP_RUNNING=1` (skip clean-exit, print `SMOKE_PID=<pid>` and `SMOKE_HOME=<dir>`), `BUN_VERSION` (default 1.2.10), `UV_VERSION` (default 0.12.15). Exit 0 on pass, 1 on fail.

Dev-host prerequisites: `sudo dnf install -y xorg-x11-server-Xvfb xorg-x11-xauth curl`.

- [ ] **Step 1: Write the script**

`tests/smoke/smoke.sh`:
```bash
#!/usr/bin/env bash
# Headless launch assertions for Qwen Studio on Linux (spec section 11.5).
# Usage: tests/smoke/smoke.sh <executable> <resources-dir>
# NOTE: --no-sandbox below is a TEST-ONLY flag (Docker's default seccomp blocks user namespaces).
# It is never part of any shipped launcher or desktop file.
set -euo pipefail

EXE="${1:?executable path required}"
RES="${2:?resources dir required}"
PORT="${SMOKE_PORT:-9333}"
LOG="${SMOKE_LOG:-$PWD/smoke.log}"
BUN_VERSION="${BUN_VERSION:-1.2.10}"
UV_VERSION="${UV_VERSION:-0.12.15}"
XPID=""

dump_log() { if [ -f "$LOG" ]; then echo "--- $LOG ---" >&2; cat "$LOG" >&2; echo "--- end log ---" >&2; fi; }
fail() { echo "SMOKE FAIL: $*" >&2; dump_log; if [ -n "$XPID" ] && kill -0 "$XPID" 2>/dev/null; then kill -TERM "$XPID" 2>/dev/null || true; fi; exit 1; }
targets() { curl -s "http://127.0.0.1:$PORT/json" 2>/dev/null | tr -d '\n' | sed 's/},/}\n/g'; }

echo "== 1. sidecar versions"
[ "$("$RES/bun/bun" --version)" = "$BUN_VERSION" ] || fail "bun --version != $BUN_VERSION"
"$RES/python/uvx" --version | grep -q "^uvx $UV_VERSION" || fail "uvx --version != $UV_VERSION"
"$RES/python/uv" --version | grep -q "^uv $UV_VERSION" || fail "uv --version != $UV_VERSION"

echo "== 2. launch"
export HOME; HOME="$(mktemp -d)"
unset XDG_CONFIG_HOME
export ELECTRON_ENABLE_LOGGING=1
rm -f "$LOG"
xvfb-run -a "$EXE" --remote-debugging-port="$PORT" --no-sandbox >"$LOG" 2>&1 &
XPID=$!

echo "== 3. wait for the shell page target"
PAGE_LINE=""
for _ in $(seq 1 60); do
  PAGE_LINE="$(targets | grep '"type": *"page"' | grep 'out/renderer/index.html"' || true)"
  [ -n "$PAGE_LINE" ] && break
  kill -0 "$XPID" 2>/dev/null || fail "app exited early"
  sleep 1
done
[ -n "$PAGE_LINE" ] || fail "no page target for out/renderer/index.html within 60 s"

echo "== 4. wait for the chat.qwen.ai webview target"
WEBVIEW_LINE=""
for _ in $(seq 1 30); do
  WEBVIEW_LINE="$(targets | grep '"type": *"webview"' | grep '"url": *"https://chat.qwen.ai' || true)"
  [ -n "$WEBVIEW_LINE" ] && break
  sleep 1
done
[ -n "$WEBVIEW_LINE" ] || fail "no webview target for https://chat.qwen.ai within 30 s"

echo "== 5. log scan"
if grep -E "Unsupported platform|Cannot find module|ERR_UPDATER_INVALID_VERSION" "$LOG"; then fail "forbidden string in log"; fi

if [ "${SMOKE_KEEP_RUNNING:-0}" = "1" ]; then
  disown "$XPID"
  echo "SMOKE_PID=$XPID"
  echo "SMOKE_HOME=$HOME"
  echo "SMOKE PASS (app left running)"
  exit 0
fi

echo "== 6. clean exit via DevTools"
for id in $(targets | grep '"type": *"page"' | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p'); do
  curl -s -X PUT "http://127.0.0.1:$PORT/json/close/$id" >/dev/null || true
done
for _ in $(seq 1 30); do
  kill -0 "$XPID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$XPID" 2>/dev/null; then fail "app still running 30 s after closing all pages"; fi
RC=0; wait "$XPID" || RC=$?
[ "$RC" = "0" ] || fail "app exit code $RC (expected 0)"
echo "SMOKE PASS"
```

- [ ] **Step 2: Make it executable and run it against the assembled tree**

Run: `chmod +x tests/smoke/smoke.sh && tests/smoke/smoke.sh build/linux-unpacked/qwen-studio build/linux-unpacked/resources; echo "exit=$?"`
Expected: sections 1–6 print, ending in `SMOKE PASS`, `exit=0`, and `smoke.log` exists (ignored by git).

- [ ] **Step 3: Verify the failure path**

Run: `BUN_VERSION=9.9.9 tests/smoke/smoke.sh build/linux-unpacked/qwen-studio build/linux-unpacked/resources; echo "exit=$?"`
Expected: `SMOKE FAIL: bun --version != 9.9.9`, `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add tests/smoke/smoke.sh
git commit -m "test: add headless launch smoke test" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task C2: Container install script `tests/install/install-and-smoke.sh`

**Spec:** §11.4.

**Files:**
- Create: `tests/install/install-and-smoke.sh`

**Interfaces:**
- Produces: `bash /tests/install/install-and-smoke.sh <deb|rpm|appimage>` run inside a container with `/dist` and `/tests` mounted read-only.

- [ ] **Step 1: Write the script**

`tests/install/install-and-smoke.sh`:
```bash
#!/usr/bin/env bash
# Runs inside a distro container: installs the package for <format>, asserts the install, runs the smoke test, uninstalls.
# Usage: bash /tests/install/install-and-smoke.sh <deb|rpm|appimage>
set -euo pipefail
FORMAT="${1:?format required: deb|rpm|appimage}"
DIST="${DIST_DIR:-/dist}"
TESTS="${TESTS_DIR:-/tests}"
. /etc/os-release
echo "== distro: $ID $VERSION_ID, format: $FORMAT"

DEB_RUNTIME="libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libuuid1 libsecret-1-0 libasound2 libdrm2 libgbm1 libxkbcommon0 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libexpat1 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr6 libpango-1.0-0 libcairo2 libglib2.0-0 libnspr4 libxcb1"
RPM_RUNTIME="gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libuuid libsecret alsa-lib libdrm mesa-libgbm libxkbcommon at-spi2-atk atk cups-libs dbus-libs expat libX11 libXcomposite libXdamage libXext libXfixes libXrandr pango cairo glib2 nspr libxcb"

case "$ID" in
  ubuntu|debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq xvfb xauth curl ca-certificates procps desktop-file-utils >/dev/null
    [ "$FORMAT" = "appimage" ] && apt-get install -y -qq $DEB_RUNTIME >/dev/null
    ;;
  fedora)
    dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth curl ca-certificates procps-ng desktop-file-utils >/dev/null
    [ "$FORMAT" = "appimage" ] && dnf install -y -q $RPM_RUNTIME >/dev/null
    ;;
  *) echo "unsupported distro $ID" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"; cd "$WORK"

assert_installed_layout() {
  echo "== install assertions"
  local target; target="$(readlink -f /usr/bin/qwen-studio)"
  [ "$target" = "/opt/Qwen Studio/qwen-studio" ] || { echo "/usr/bin/qwen-studio -> $target (expected /opt/Qwen Studio/qwen-studio)"; exit 1; }
  local st; st="$(stat -c '%U %a' '/opt/Qwen Studio/chrome-sandbox')"
  case "$st" in "root 4755"|"root 755") ;; *) echo "chrome-sandbox owner/mode: $st"; exit 1;; esac
  desktop-file-validate /usr/share/applications/qwen-studio.desktop
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
  local handler; handler="$(xdg-mime query default x-scheme-handler/qwen || true)"
  [ "$handler" = "qwen-studio.desktop" ] || { echo "xdg-mime handler for qwen:// is '$handler'"; exit 1; }
  echo "layout ok"
}

case "$FORMAT" in
  deb)
    apt-get install -y -qq "$DIST"/qwen-studio_*.deb >/dev/null
    assert_installed_layout
    bash "$TESTS/smoke/smoke.sh" "/opt/Qwen Studio/qwen-studio" "/opt/Qwen Studio/resources"
    apt-get remove -y -qq qwen-studio >/dev/null
    [ ! -e "/opt/Qwen Studio" ] || { echo "/opt/Qwen Studio still present after removal"; ls -la "/opt/Qwen Studio"; exit 1; }
    ;;
  rpm)
    dnf install -y -q "$DIST"/qwen-studio-*.rpm >/dev/null
    assert_installed_layout
    bash "$TESTS/smoke/smoke.sh" "/opt/Qwen Studio/qwen-studio" "/opt/Qwen Studio/resources"
    dnf remove -y -q qwen-studio >/dev/null
    [ ! -e "/opt/Qwen Studio" ] || { echo "/opt/Qwen Studio still present after removal"; exit 1; }
    ;;
  appimage)
    cp "$DIST"/qwen-studio-*.AppImage ./app.AppImage && chmod +x ./app.AppImage
    ./app.AppImage --appimage-extract >/dev/null
    [ ! -e squashfs-root/resources/package-type ] || { echo "package-type must not exist in the AppImage"; exit 1; }
    bash "$TESTS/smoke/smoke.sh" "$WORK/squashfs-root/qwen-studio" "$WORK/squashfs-root/resources"
    ;;
  *) echo "unknown format $FORMAT" >&2; exit 1 ;;
esac
echo "INSTALL+SMOKE PASS ($ID $VERSION_ID, $FORMAT)"
```

- [ ] **Step 2: Run one deb leg and one AppImage leg locally**

Run:
```bash
chmod +x tests/install/install-and-smoke.sh
docker run --rm --shm-size=1g -v "$PWD/dist:/dist:ro" -v "$PWD/tests:/tests:ro" ubuntu:24.04 bash /tests/install/install-and-smoke.sh deb
docker run --rm --shm-size=1g -v "$PWD/dist:/dist:ro" -v "$PWD/tests:/tests:ro" fedora:41 bash /tests/install/install-and-smoke.sh appimage
```
Expected: both end with `INSTALL+SMOKE PASS (...)`. If the deb leg fails at `apt-get install` with an unresolvable dependency on 24.04, the `t64` rename is not covered by `Provides` for that library; report the exact package name (the spec relies on `Provides`).

- [ ] **Step 3: Commit**

```bash
git add tests/install/install-and-smoke.sh
git commit -m "test: add container install and smoke script" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task C3: Reusable workflow `build-and-test.yml`

**Spec:** §11.2, §11.3, §11.4, §12.1.

**Files:**
- Create: `.github/workflows/build-and-test.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: build-and-test

on:
  workflow_call:

permissions:
  contents: read

jobs:
  build:
    name: Build packages
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - name: Install build tools
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq p7zip-full unzip rpm lintian rpmlint desktop-file-utils libfuse2 xvfb xauth cpio pipx
      - name: Cache downloads
        uses: actions/cache@v4
        with:
          path: .cache
          key: downloads-${{ hashFiles('upstream.json', 'sidecars.json') }}
      - run: npm ci
      - run: npm run build
      - run: npm run verify
      - name: lintian (errors fail)
        run: lintian --suppress-tags-from-file packaging/lintian/qwen-studio.overrides --fail-on error --no-tag-display-limit dist/*.deb
      - name: rpmlint (errors fail)
        run: |
          rpmlint -c packaging/rpmlint/qwen-studio.toml dist/*.rpm | tee rpmlint.txt
          grep -Eq '; 0 errors' rpmlint.txt
      - name: appimagelint (advisory)
        continue-on-error: true
        run: |
          pipx install git+https://github.com/TheAssassin/appimagelint@27f5d08808fd2a96543f4efb72e1b824b3e32652
          ~/.local/bin/appimagelint dist/*.AppImage | tee appimagelint.txt
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: appimagelint-report
          path: appimagelint.txt
          if-no-files-found: ignore
      - uses: actions/upload-artifact@v4
        with:
          name: packages
          path: dist/
          retention-days: 7
          if-no-files-found: error

  install-matrix:
    name: ${{ matrix.leg }}
    needs: build
    runs-on: ubuntu-22.04
    strategy:
      fail-fast: false
      matrix:
        include:
          - { leg: deb-ubuntu-22.04, image: "ubuntu:22.04", format: deb }
          - { leg: deb-ubuntu-24.04, image: "ubuntu:24.04", format: deb }
          - { leg: deb-debian-12, image: "debian:12", format: deb }
          - { leg: rpm-fedora-40, image: "fedora:40", format: rpm }
          - { leg: rpm-fedora-41, image: "fedora:41", format: rpm }
          - { leg: appimage-ubuntu-22.04, image: "ubuntu:22.04", format: appimage }
          - { leg: appimage-fedora-41, image: "fedora:41", format: appimage }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: packages
          path: dist
      - name: Install and smoke in ${{ matrix.image }}
        run: |
          mkdir -p logs
          docker run --rm --shm-size=1g \
            -v "$PWD/dist:/dist:ro" -v "$PWD/tests:/tests:ro" -v "$PWD/logs:/logs" \
            -e SMOKE_LOG=/logs/smoke.log \
            "${{ matrix.image }}" bash /tests/install/install-and-smoke.sh "${{ matrix.format }}"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: smoke-log-${{ matrix.leg }}
          path: logs/
          if-no-files-found: ignore
```

- [ ] **Step 2: Validate the YAML locally**

Run: `node -e 'const y=require("js-yaml");const d=y.load(require("fs").readFileSync(".github/workflows/build-and-test.yml","utf8"));console.log(Object.keys(d.jobs), d.jobs["install-matrix"].strategy.matrix.include.length)'`
Expected: `[ 'build', 'install-matrix' ] 7`.

- [ ] **Step 3: Commit and push to trigger nothing yet (workflow_call only)**

```bash
git add .github/workflows/build-and-test.yml
git commit -m "ci: add reusable build-and-test workflow" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task C4: `ci.yml` with docs-only detection, `ci-status`, and the `needs-human` labeller

**Spec:** §12.2, §11.6 (commitlint, semantic PR title, npm audit).

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  changes:
    name: Detect docs-only changes
    runs-on: ubuntu-22.04
    outputs:
      build_needed: ${{ steps.decide.outputs.build_needed }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: decide
        env:
          EVENT: ${{ github.event_name }}
          BASE: ${{ github.event.pull_request.base.sha }}
          HEAD: ${{ github.event.pull_request.head.sha }}
        run: |
          if [ "$EVENT" != "pull_request" ]; then echo "build_needed=true" >> "$GITHUB_OUTPUT"; exit 0; fi
          files=$(git diff --name-only "$BASE" "$HEAD")
          echo "$files"
          if echo "$files" | grep -Evq '^(docs/|.*\.md$|\.github/ISSUE_TEMPLATE/|LICENSE$|\.github/CODEOWNERS$)'; then
            echo "build_needed=true" >> "$GITHUB_OUTPUT"
          else
            echo "build_needed=false" >> "$GITHUB_OUTPUT"
          fi

  lint-unit:
    name: Typecheck, unit tests, audit, commit lint
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test:unit
      - run: npm audit --audit-level=high
      - name: commitlint
        if: github.event_name == 'pull_request'
        uses: wagoid/commitlint-github-action@v6
      - name: Conventional PR title
        if: github.event_name == 'pull_request'
        uses: amannn/action-semantic-pull-request@v5
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  build-and-test:
    needs: changes
    if: needs.changes.outputs.build_needed == 'true'
    uses: ./.github/workflows/build-and-test.yml

  ci-status:
    name: ci-status
    needs: [changes, lint-unit, build-and-test]
    if: always()
    runs-on: ubuntu-22.04
    steps:
      - env:
          LINT: ${{ needs.lint-unit.result }}
          BUILD: ${{ needs.build-and-test.result }}
          NEEDED: ${{ needs.changes.outputs.build_needed }}
        run: |
          echo "lint-unit=$LINT build-and-test=$BUILD build_needed=$NEEDED"
          [ "$LINT" = "success" ] || { echo "lint-unit failed"; exit 1; }
          if [ "$NEEDED" = "true" ]; then [ "$BUILD" = "success" ] || { echo "build-and-test failed"; exit 1; }
          else [ "$BUILD" = "skipped" ] || [ "$BUILD" = "success" ] || { echo "unexpected build-and-test result $BUILD"; exit 1; }
          fi
          echo "ci-status: success"

  flag-needs-human:
    name: Flag failed upstream bump
    needs: [ci-status]
    if: failure() && github.event_name == 'pull_request' && startsWith(github.head_ref, 'upstream/')
    runs-on: ubuntu-22.04
    steps:
      - env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR: ${{ github.event.pull_request.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          REPO: ${{ github.repository }}
        run: |
          gh pr edit "$PR" --repo "$REPO" --add-label needs-human --remove-label automerge || gh pr edit "$PR" --repo "$REPO" --add-label needs-human
          marker="<!-- ci-failure-run-${{ github.run_id }} -->"
          if ! gh pr view "$PR" --repo "$REPO" --json comments -q '.comments[].body' | grep -q "$marker"; then
            gh pr comment "$PR" --repo "$REPO" --body "$marker
          Automated upstream bump failed CI. See $RUN_URL. A maintainer must fix the branch or close this PR."
          fi
```

- [ ] **Step 2: Create the labels the workflows use**

Run: `for l in needs-human:d93f0b automerge:0e8a16 upstream-bump:1d76db dependencies:0366d6 qa-defect:b60205; do gh label create "${l%%:*}" --color "${l##*:}" --repo sams-git-195/qwenstudio-linux --force; done`
Expected: five labels created (or updated).

- [ ] **Step 3: Validate and commit, then open the first PR to see CI run**

Run: `node -e 'const y=require("js-yaml");const d=y.load(require("fs").readFileSync(".github/workflows/ci.yml","utf8"));console.log(Object.keys(d.jobs))'`
Expected: `[ 'changes', 'lint-unit', 'build-and-test', 'ci-status', 'flag-needs-human' ]`.

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add PR/main pipeline with docs-only fast path and ci-status gate" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --fill --repo sams-git-195/qwenstudio-linux
```
Expected: the PR shows checks `Detect docs-only changes`, `Typecheck, unit tests, audit, commit lint`, `Build packages`, the seven matrix legs and `ci-status`, all green. Fix any red job before merging (common causes: a missing apt package in `build-and-test.yml`, or `npm audit` findings — resolve audit findings by bumping the affected devDependency).

---

### Task C5: CodeQL and Dependabot

**Spec:** §11.6.

**Files:**
- Create: `.github/workflows/codeql.yml`, `.github/dependabot.yml`

- [ ] **Step 1: Write `.github/workflows/codeql.yml`**

```yaml
name: codeql

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "23 5 * * 1"

permissions:
  contents: read
  security-events: write

jobs:
  analyze:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@v3
```

- [ ] **Step 2: Write `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    labels: [dependencies]
    commit-message:
      prefix: "build"
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    labels: [dependencies]
    commit-message:
      prefix: "ci"
```

- [ ] **Step 3: Commit and open a PR**

```bash
git add .github/workflows/codeql.yml .github/dependabot.yml
git commit -m "ci: enable CodeQL analysis and Dependabot" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin HEAD && gh pr create --fill --repo sams-git-195/qwenstudio-linux
```
Expected: `codeql` and `ci` both green on the PR; after merge, the repository's Security tab shows CodeQL results and Dependabot is listed under Insights → Dependency graph.

---

# Workstream D — Release and upstream bot

### Task D1: `changelog.ts` and `CHANGELOG.md`

**Spec:** §12.4 (jobs 3–4), §12.3 step 5, §14 (`CHANGELOG.md`).

**Files:**
- Create: `scripts/changelog.ts`, `CHANGELOG.md`, `tests/unit/changelog.test.ts`

**Interfaces:**
- Produces (pure): `addUnreleased(md: string, line: string): string`, `finalize(md: string, tag: string, date: string): string`, `renderReleaseHeader(v: DerivedVersions, up: UpstreamManifest, sc: SidecarsManifest, sha256Lines: string): string`, `unreleasedSection(md): string`.
- CLI: `npm run changelog -- --add "<line>"` (edits `CHANGELOG.md`), `-- --finalize <tag>` (edits `CHANGELOG.md`, date = today UTC), `-- --release-notes <sha256sums-file>` (writes `build/notes.md`).

- [ ] **Step 1: Create `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to the Linux packaging of Qwen Studio are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Upstream application changes are not tracked here; see https://chat.qwen.ai/.

## [Unreleased]

- Initial Linux packaging (deb, rpm, AppImage) of Qwen Studio 1.0.3.44.
```

- [ ] **Step 2: Write the failing test**

`tests/unit/changelog.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { addUnreleased, finalize, unreleasedSection, renderReleaseHeader } from "../../scripts/changelog.js";
import { deriveVersions } from "../../scripts/lib/versions.js";
import { readUpstream, readSidecars } from "../../scripts/lib/manifest.js";

const md = `# Changelog\n\nIntro.\n\n## [Unreleased]\n\n- First.\n\n## [v1.0.3.43-1] - 2026-01-01\n\n- Old.\n`;

describe("changelog", () => {
  it("adds a line under Unreleased", () => {
    const out = addUnreleased(md, "Upstream bump to 1.0.3.45 (released 2026-09-01T00:00:00.000Z)");
    expect(unreleasedSection(out)).toBe("- Upstream bump to 1.0.3.45 (released 2026-09-01T00:00:00.000Z)\n- First.\n");
  });
  it("finalizes Unreleased into a tagged section and leaves Unreleased empty", () => {
    const out = finalize(md, "v1.0.3.44-1", "2026-09-15");
    expect(out).toContain("## [Unreleased]\n\n## [v1.0.3.44-1] - 2026-09-15\n\n- First.\n\n## [v1.0.3.43-1] - 2026-01-01");
    expect(unreleasedSection(out)).toBe("");
  });
  it("finalize with an empty Unreleased inserts a placeholder-free section", () => {
    const out = finalize(finalize(md, "v1.0.3.44-1", "2026-09-15"), "v1.0.3.44-2", "2026-09-16");
    expect(out).toContain("## [v1.0.3.44-2] - 2026-09-16\n\n- Wrapper-only release; no changelog entries recorded.\n");
  });
  it("renders the release header", () => {
    const h = renderReleaseHeader(deriveVersions(readUpstream()), readUpstream(), readSidecars(), "abc  qwen-studio_1.0.3.44-1_amd64.deb\n");
    expect(h).toContain("Upstream Qwen Studio **1.0.3** build **44**");
    expect(h).toContain("Electron 35.1.4, bun 1.2.10, uv 0.12.15");
    expect(h).toContain("not affiliated");
    expect(h).toContain("sudo apt install ./qwen-studio_1.0.3.44-1_amd64.deb");
    expect(h).toContain("abc  qwen-studio_1.0.3.44-1_amd64.deb");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/changelog.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/changelog.js'`.

- [ ] **Step 4: Implement `scripts/changelog.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readUpstream, readSidecars, type UpstreamManifest, type SidecarsManifest } from "./lib/manifest.js";
import { deriveVersions, type DerivedVersions } from "./lib/versions.js";
import { ROOT, BUILD_DIR } from "./lib/paths.js";

const UNRELEASED = "## [Unreleased]";

function splitAtUnreleased(md: string): { head: string; body: string; rest: string } {
  const i = md.indexOf(UNRELEASED);
  if (i === -1) throw new Error("CHANGELOG.md has no '## [Unreleased]' section");
  const afterHeading = i + UNRELEASED.length;
  const next = md.indexOf("\n## ", afterHeading);
  const body = next === -1 ? md.slice(afterHeading) : md.slice(afterHeading, next + 1);
  const rest = next === -1 ? "" : md.slice(next + 1);
  return { head: md.slice(0, afterHeading), body, rest };
}

export function unreleasedSection(md: string): string {
  return splitAtUnreleased(md).body.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/^\n$/, "");
}

export function addUnreleased(md: string, line: string): string {
  const { head, body, rest } = splitAtUnreleased(md);
  const items = unreleasedSection(md);
  const newBody = `\n\n- ${line}\n${items}${items ? "\n" : "\n"}`;
  void body;
  return `${head}${newBody}${rest}`;
}

export function finalize(md: string, tag: string, date: string): string {
  const { head, rest } = splitAtUnreleased(md);
  const items = unreleasedSection(md) || "- Wrapper-only release; no changelog entries recorded.\n";
  return `${head}\n\n## [${tag}] - ${date}\n\n${items}\n${rest}`;
}

export function renderReleaseHeader(v: DerivedVersions, up: UpstreamManifest, sc: SidecarsManifest, sha256Lines: string): string {
  return [
    `Upstream Qwen Studio **${up.version}** build **${up.build}** (upstream release date ${up.releaseDate}), Linux wrapper revision **${up.wrapper_revision}**.`,
    ``,
    `Runtime: Electron ${sc.electron.version}, bun ${sc.bun.version}, uv ${sc.uv.version}.`,
    ``,
    `> This is an unofficial community packaging and is not affiliated with, endorsed by or supported by Alibaba Cloud. The application itself is proprietary software by Alibaba; only the packaging scripts are MIT-licensed. The app bundles Alibaba's telemetry (\`@ali/aes-tracker\`).`,
    ``,
    `### Install`,
    ``,
    `- Debian/Ubuntu: \`sudo apt install ./${v.artifacts.deb}\``,
    `- Fedora: \`sudo dnf install ./${v.artifacts.rpm}\``,
    `- AppImage: \`chmod +x ${v.artifacts.appImage} && ./${v.artifacts.appImage}\` (needs \`libfuse2\`; or run with \`--appimage-extract\`)`,
    ``,
    `AppImage installs update in-app; deb/rpm installs show a notification pointing here.`,
    ``,
    `### SHA-256`,
    ``,
    "```",
    sha256Lines.trimEnd(),
    "```",
    ``,
  ].join("\n");
}

export function main(argv = process.argv.slice(2)): void {
  const changelogPath = path.join(ROOT, "CHANGELOG.md");
  const md = readFileSync(changelogPath, "utf8");
  if (argv[0] === "--add") { writeFileSync(changelogPath, addUnreleased(md, argv[1])); console.log("CHANGELOG.md: added unreleased entry"); return; }
  if (argv[0] === "--finalize") {
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(changelogPath, finalize(md, argv[1], date)); console.log(`CHANGELOG.md: finalized ${argv[1]} (${date})`); return;
  }
  if (argv[0] === "--release-notes") {
    const up = readUpstream(); const v = deriveVersions(up);
    const header = renderReleaseHeader(v, up, readSidecars(), readFileSync(argv[1], "utf8"));
    const items = unreleasedSection(md);
    mkdirSync(BUILD_DIR, { recursive: true });
    writeFileSync(path.join(BUILD_DIR, "notes.md"), `${header}\n### Changes\n\n${items || "- Wrapper-only release; no changelog entries recorded.\n"}\n`);
    console.log("wrote build/notes.md"); return;
  }
  console.error("usage: changelog --add <line> | --finalize <tag> | --release-notes <SHA256SUMS>"); process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 5: Run tests and the CLI**

Run: `npx vitest run tests/unit/changelog.test.ts && npm run typecheck && printf 'abc  x.deb\n' > /tmp/sums && npm run changelog -- --release-notes /tmp/sums && head -5 build/notes.md`
Expected: tests PASS; `build/notes.md` starts with `Upstream Qwen Studio **1.0.3** build **44**`.

- [ ] **Step 6: Commit**

```bash
git add scripts/changelog.ts CHANGELOG.md tests/unit/changelog.test.ts
git commit -m "feat: add changelog maintenance and release notes rendering" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task D2: `release.yml`

**Spec:** §12.4, §12.5.

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: release

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write
  id-token: write
  attestations: write
  pull-requests: write

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  plan:
    name: Plan release
    runs-on: ubuntu-22.04
    outputs:
      tag: ${{ steps.plan.outputs.tag }}
      name: ${{ steps.plan.outputs.name }}
      skip: ${{ steps.plan.outputs.skip }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - id: plan
        run: |
          TAG=$(npm run -s version -- --print gitTag)
          NAME=$(npm run -s version -- --print releaseName)
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "name=$NAME" >> "$GITHUB_OUTPUT"
          if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null; then
            echo "::notice::Tag $TAG already exists; nothing to release"
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "skip=false" >> "$GITHUB_OUTPUT"
          fi

  build-and-test:
    needs: plan
    if: needs.plan.outputs.skip != 'true'
    uses: ./.github/workflows/build-and-test.yml

  publish:
    name: Publish GitHub Release
    needs: [plan, build-and-test]
    if: needs.plan.outputs.skip != 'true'
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - uses: actions/download-artifact@v4
        with:
          name: packages
          path: dist
      - name: Checksums
        run: cd dist && sha256sum *.deb *.rpm *.AppImage latest-linux.yml > SHA256SUMS && cat SHA256SUMS
      - uses: actions/attest-build-provenance@v2
        with:
          subject-path: |
            dist/*.deb
            dist/*.rpm
            dist/*.AppImage
      - name: Release notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ needs.plan.outputs.tag }}
        run: |
          npm run -s changelog -- --release-notes dist/SHA256SUMS
          PREV=$(gh release list --repo "$GITHUB_REPOSITORY" --exclude-drafts --exclude-pre-releases --limit 1 --json tagName -q '.[0].tagName' || true)
          if [ -n "$PREV" ]; then
            gh api "repos/$GITHUB_REPOSITORY/releases/generate-notes" -f tag_name="$TAG" -f previous_tag_name="$PREV" -f target_commitish="$GITHUB_SHA" -q .body >> build/notes.md
          else
            gh api "repos/$GITHUB_REPOSITORY/releases/generate-notes" -f tag_name="$TAG" -f target_commitish="$GITHUB_SHA" -q .body >> build/notes.md
          fi
          cat build/notes.md
      - name: Create release (latest-linux.yml uploaded last)
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ needs.plan.outputs.tag }}
          NAME: ${{ needs.plan.outputs.name }}
        run: |
          gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --title "$NAME" --notes-file build/notes.md --latest \
            dist/*.deb dist/*.rpm dist/*.AppImage dist/SHA256SUMS
          gh release upload "$TAG" --repo "$GITHUB_REPOSITORY" dist/latest-linux.yml

  changelog:
    name: Changelog PR
    needs: [plan, publish]
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.UPSTREAM_BOT_TOKEN }}
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - env:
          GH_TOKEN: ${{ secrets.UPSTREAM_BOT_TOKEN }}
          TAG: ${{ needs.plan.outputs.tag }}
        run: |
          git config user.name "qwenstudio-linux-bot"
          git config user.email "noreply@github.com"
          BR="release/changelog-$TAG"
          git checkout -b "$BR"
          npm run -s changelog -- --finalize "$TAG"
          git add CHANGELOG.md
          git commit -m "chore(release): changelog for $TAG"
          git push -f origin "$BR"
          PR=$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$BR" --state open --json number -q '.[0].number')
          if [ -z "$PR" ]; then
            PR=$(gh pr create --repo "$GITHUB_REPOSITORY" --base main --head "$BR" --title "chore(release): changelog for $TAG" --body "Finalizes CHANGELOG.md for $TAG. Docs-only; auto-merges when ci-status passes." --label automerge | grep -o '[0-9]*$')
          fi
          gh pr merge "$PR" --repo "$GITHUB_REPOSITORY" --auto --squash
```

- [ ] **Step 2: Validate YAML and commit**

Run: `node -e 'const y=require("js-yaml");const d=y.load(require("fs").readFileSync(".github/workflows/release.yml","utf8"));console.log(Object.keys(d.jobs))'`
Expected: `[ 'plan', 'build-and-test', 'publish', 'changelog' ]`.

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow with attestation and changelog PR" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin HEAD && gh pr create --fill --repo sams-git-195/qwenstudio-linux
```

- [ ] **Step 3: Merge and watch the first release**

After the PR is merged (CI green), run: `gh run watch --repo sams-git-195/qwenstudio-linux $(gh run list --repo sams-git-195/qwenstudio-linux --workflow release --limit 1 --json databaseId -q '.[0].databaseId')`
Expected: `plan` → `build-and-test` → `publish` → `changelog` all succeed; `gh release view v1.0.3.44-1 --repo sams-git-195/qwenstudio-linux` lists 5 assets (`.deb`, `.rpm`, `.AppImage`, `SHA256SUMS`, `latest-linux.yml`), not prerelease; a PR `chore(release): changelog for v1.0.3.44-1` is open with auto-merge enabled (it merges once `ci-status` passes; the subsequent `release` run reports `Tag v1.0.3.44-1 already exists`). Requires the owner to have configured `UPSTREAM_BOT_TOKEN` and §13 settings; if not yet done, the `changelog` job fails with an auth error — re-run it after the settings exist.

---

### Task D3: `upstream-check.ts` (bot logic)

**Spec:** §12.3.

**Files:**
- Create: `scripts/upstream-check.ts`, `tests/unit/upstream-check.test.ts`

**Interfaces:**
- Consumes: `parseFeed`, `readUpstream`, `UpstreamManifest`, `FeedInfo` (A2); `fetchCached` (A4); `run` (A4); `deriveVersions` (A3); `addUnreleased` via CLI (D1).
- Produces (pure, tested): `compareUpstream(a: {version; build}, b: {version; build}): -1 | 0 | 1`; `branchName(base: string, version: string, build: number): string`; `nextManifest(feed: FeedInfo): UpstreamManifest`; `renderPrBody(args: { feed: FeedInfo; checks: CheckResult[]; electronDetected?: string }): string`; `type CheckResult = { name: string; ok: boolean; output: string }`.
- CLI: `npm run upstream-check -- --feed-url <url> --base-branch <branch> [--dry-run]`; env `GH_TOKEN` (the bot PAT), `GITHUB_REPOSITORY`.

- [ ] **Step 1: Write the failing test**

`tests/unit/upstream-check.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/upstream-check.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/upstream-check.js'`.

- [ ] **Step 3: Implement `scripts/upstream-check.ts`**

```ts
import { readFileSync, writeFileSync, copyFileSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { parseFeed, readUpstream, validateUpstream, type FeedInfo, type UpstreamManifest } from "./lib/manifest.js";
import { run } from "./lib/exec.js";
import { ROOT, APP_PRISTINE_DIR } from "./lib/paths.js";

export const DEFAULT_FEED = "https://download.qwen.ai/windows/x64/latest.yml";
export type CheckResult = { name: string; ok: boolean; output: string };

export function compareUpstream(a: { version: string; build: number }, b: { version: string; build: number }): -1 | 0 | 1 {
  const c = semver.compare(a.version, b.version);
  if (c !== 0) return c as -1 | 1;
  return a.build === b.build ? 0 : a.build > b.build ? 1 : -1;
}

export function branchName(base: string, version: string, build: number): string {
  return `upstream/${base}/v${version}.${build}`;
}

export function nextManifest(feed: FeedInfo): UpstreamManifest {
  return validateUpstream({ version: feed.version, build: feed.build, wrapper_revision: 1, url: feed.url, sha512: feed.sha512, size: feed.size, releaseDate: feed.releaseDate });
}

export function renderPrBody(a: { feed: FeedInfo; checks: CheckResult[] }): string {
  const lines = [
    `Automated upstream bump to Qwen Studio **${a.feed.version}.${a.feed.build}**.`, ``,
    `- Installer: ${a.feed.url}`, `- SHA-512: \`${a.feed.sha512}\``, `- Upstream release date: ${a.feed.releaseDate}`, ``,
    `### Pre-flight checks`, ``,
    ...a.checks.map((c) => `- [${c.ok ? "x" : " "}] ${c.name}${c.output ? `\n\n  \`\`\`\n  ${c.output.trim().split("\n").join("\n  ")}\n  \`\`\`` : ""}`),
    ``, `CI: pending`, ``,
    `_Opened by the upstream-check workflow. If all checks and CI pass, this PR auto-merges and a release is published._`,
  ];
  return lines.join("\n");
}

function sh(cmd: string, args: string[], opts: { allowFailure?: boolean } = {}): { ok: boolean; output: string } {
  try { return { ok: true, output: run(cmd, args, { cwd: ROOT, capture: true }) }; }
  catch (e) { if (opts.allowFailure) return { ok: false, output: (e as Error).message }; throw e; }
}

function stageCheck(name: string, script: string): CheckResult {
  const r = sh("npm", ["run", "-s", script], { allowFailure: true });
  return { name, ok: r.ok, output: r.ok ? "" : r.output.slice(-2000) };
}

function gh(args: string[], allowFailure = false): string {
  return run("gh", args, { cwd: ROOT, capture: true, allowFailure });
}

function reportFailure(reason: string, detail: string): never {
  const repo = process.env.GITHUB_REPOSITORY ?? "sams-git-195/qwenstudio-linux";
  const title = `Upstream bot failure: ${reason}`;
  const existing = gh(["issue", "list", "--repo", repo, "--state", "open", "--search", `in:title "${title}"`, "--json", "number,title", "-q", `.[] | select(.title == "${title}") | .number`]).trim();
  const body = `The daily upstream check failed.\n\n**Reason:** ${reason}\n\n\`\`\`\n${detail.slice(-4000)}\n\`\`\`\n\nRun: ${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? "local"}`;
  if (existing) gh(["issue", "comment", existing.split("\n")[0], "--repo", repo, "--body", body]);
  else gh(["issue", "create", "--repo", repo, "--title", title, "--label", "needs-human", "--body", body]);
  console.error(title); process.exit(1);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const arg = (k: string, d: string) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };
  const feedUrl = arg("--feed-url", DEFAULT_FEED); const base = arg("--base-branch", "main"); const dryRun = argv.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY ?? "sams-git-195/qwenstudio-linux";

  let feed: FeedInfo;
  try {
    const res = await fetch(feedUrl, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${feedUrl}`);
    feed = parseFeed(await res.text(), feedUrl);
  } catch (e) { reportFailure("cannot read or parse the upstream feed", (e as Error).message); }

  const current = readUpstream();
  if (compareUpstream(feed, current) <= 0) { console.log(`Up to date (feed ${feed.version}.${feed.build}, local ${current.version}.${current.build})`); return; }
  console.log(`New upstream ${feed.version}.${feed.build} (local ${current.version}.${current.build})`);

  const next = nextManifest(feed);
  const manifestPath = path.join(ROOT, "upstream.json");
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");

  const checks: CheckResult[] = [];
  checks.push(stageCheck("installer download and SHA-512 verification", "fetch"));
  if (checks[0].ok) {
    const fetched = JSON.parse(readFileSync(path.join(ROOT, "build", "fetch.json"), "utf8")) as { installer: string };
    next.size = statSync(fetched.installer).size;
    writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
    checks.push(stageCheck("extract, app version check and Electron version check", "extract"));
    if (checks[1].ok) {
      checks.push(stageCheck("patches apply (git apply --check)", "patch"));
      mkdirSync(path.join(ROOT, "tests/fixtures/app-pristine/out/main"), { recursive: true });
      copyFileSync(path.join(APP_PRISTINE_DIR, "out/main/index.js"), path.join(ROOT, "tests/fixtures/app-pristine/out/main/index.js"));
    }
  }
  run("npm", ["run", "-s", "changelog", "--", "--add", `Upstream bump to ${feed.version}.${feed.build} (released ${feed.releaseDate})`], { cwd: ROOT });
  const allOk = checks.every((c) => c.ok);
  const body = renderPrBody({ feed, checks });
  const branch = branchName(base, feed.version, feed.build);
  const title = `chore(upstream): bump Qwen Studio to ${feed.version}.${feed.build}`;

  if (dryRun) { console.log(run("git", ["diff", "--stat"], { cwd: ROOT, capture: true })); console.log(`\n[dry-run] would push ${branch} and open PR "${title}" (auto-merge: ${allOk})\n\n${body}`); return; }

  run("git", ["config", "user.name", "qwenstudio-linux-bot"], { cwd: ROOT });
  run("git", ["config", "user.email", "noreply@github.com"], { cwd: ROOT });
  run("git", ["checkout", "-B", branch], { cwd: ROOT });
  run("git", ["add", "upstream.json", "CHANGELOG.md", "tests/fixtures/app-pristine/out/main/index.js"], { cwd: ROOT });
  run("git", ["commit", "-m", title], { cwd: ROOT });
  run("git", ["push", "-f", "origin", branch], { cwd: ROOT });

  let pr = gh(["pr", "list", "--repo", repo, "--head", branch, "--base", base, "--state", "open", "--json", "number", "-q", ".[0].number"]).trim();
  if (pr) { gh(["pr", "edit", pr, "--repo", repo, "--title", title, "--body", body]); }
  else { pr = gh(["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body", body, "--label", "upstream-bump"]).trim().split("/").pop() ?? ""; }
  if (allOk) {
    gh(["pr", "edit", pr, "--repo", repo, "--add-label", "automerge", "--remove-label", "needs-human"], true);
    gh(["pr", "merge", pr, "--repo", repo, "--auto", "--squash"]);
    console.log(`PR #${pr} opened with auto-merge`);
  } else {
    gh(["pr", "edit", pr, "--repo", repo, "--add-label", "needs-human", "--remove-label", "automerge"], true);
    gh(["pr", "comment", pr, "--repo", repo, "--body", `Pre-flight checks failed; a maintainer must fix this branch.\n\n${checks.filter((c) => !c.ok).map((c) => `**${c.name}**\n\`\`\`\n${c.output}\n\`\`\``).join("\n\n")}`]);
    console.log(`PR #${pr} opened and labelled needs-human`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run tests and a local dry run**

Run: `npx vitest run tests/unit/upstream-check.test.ts && npm run typecheck && npm run upstream-check -- --dry-run`
Expected: tests PASS; dry run prints `Up to date (feed 1.0.3.44, local 1.0.3.44)` and changes nothing (`git status --short` shows only intended files from this task).

- [ ] **Step 5: Local dry run of a simulated bump**

Run:
```bash
cp upstream.json /tmp/upstream.bak
sed -i 's/"build": 44/"build": 43/' upstream.json
npm run upstream-check -- --dry-run | tail -40
cp /tmp/upstream.bak upstream.json && git checkout -- CHANGELOG.md tests/fixtures/app-pristine/out/main/index.js && git status --short
```
Expected: the dry run prints `New upstream 1.0.3.44 (local 1.0.3.43)`, runs fetch/extract/patch (all `[x]`), prints the PR body with `CI: pending` and `(auto-merge: true)`; after restoring, `git status --short` shows only this task's new files.

- [ ] **Step 6: Commit**

```bash
git add scripts/upstream-check.ts tests/unit/upstream-check.test.ts
git commit -m "feat: add upstream version tracking bot logic" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task D4: `upstream-check.yml`

**Spec:** §12.3.

**Files:**
- Create: `.github/workflows/upstream-check.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: upstream-check

on:
  schedule:
    - cron: "17 4 * * *"
  workflow_dispatch:
    inputs:
      feed_url:
        description: Upstream feed URL
        default: https://download.qwen.ai/windows/x64/latest.yml
        type: string
      base_branch:
        description: Branch to compare against and target with the PR
        default: main
        type: string
      dry_run:
        description: Print what would happen without pushing or opening a PR
        default: false
        type: boolean

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: upstream-check-${{ inputs.base_branch || 'main' }}
  cancel-in-progress: false

jobs:
  check:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.base_branch || 'main' }}
          token: ${{ secrets.UPSTREAM_BOT_TOKEN }}
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: sudo apt-get update -qq && sudo apt-get install -y -qq p7zip-full unzip
      - uses: actions/cache@v4
        with:
          path: .cache
          key: downloads-bot-${{ github.run_id }}
          restore-keys: downloads-
      - run: npm ci
      - env:
          GH_TOKEN: ${{ secrets.UPSTREAM_BOT_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
        run: |
          npm run -s upstream-check -- \
            --feed-url "${{ inputs.feed_url || 'https://download.qwen.ai/windows/x64/latest.yml' }}" \
            --base-branch "${{ inputs.base_branch || 'main' }}" \
            ${{ (inputs.dry_run == true) && '--dry-run' || '' }}
```

- [ ] **Step 2: Validate, commit, merge**

Run: `node -e 'const y=require("js-yaml");const d=y.load(require("fs").readFileSync(".github/workflows/upstream-check.yml","utf8"));console.log(Object.keys(d.on.workflow_dispatch.inputs))'`
Expected: `[ 'feed_url', 'base_branch', 'dry_run' ]`.

```bash
git add .github/workflows/upstream-check.yml
git commit -m "ci: add daily upstream version check workflow" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin HEAD && gh pr create --fill --repo sams-git-195/qwenstudio-linux
```

- [ ] **Step 3: After merge, run a dry run on GitHub**

Run: `gh workflow run upstream-check.yml --repo sams-git-195/qwenstudio-linux -f dry_run=true && sleep 30 && gh run list --repo sams-git-195/qwenstudio-linux --workflow upstream-check --limit 1`
Expected: the run succeeds and its log ends with `Up to date (feed 1.0.3.44, local 1.0.3.44)`.

---

### Task D5: `docs/RELEASING.md` and `docs/BRANCH_PROTECTION.md`

**Spec:** §12.4, §12.5, §13, §14.

**Files:**
- Create: `docs/RELEASING.md`, `docs/BRANCH_PROTECTION.md`

- [ ] **Step 1: Write `docs/RELEASING.md`**

```markdown
# Releasing

Releases are fully automatic. This page explains the flow and the manual recoveries.

## Normal flow

1. `upstream-check.yml` runs daily (04:17 UTC). When `https://download.qwen.ai/windows/x64/latest.yml` advertises a newer version/build than `upstream.json`, it downloads and verifies the installer, checks that the patches apply and that the Electron version is unchanged, updates `upstream.json` (`wrapper_revision` reset to 1), refreshes `tests/fixtures/app-pristine/out/main/index.js`, adds a `CHANGELOG.md` entry, pushes `upstream/main/v<version>.<build>` and opens a PR labelled `upstream-bump`.
2. If the pre-flight checks passed, the PR gets `automerge` and auto-merge is enabled. `ci.yml` runs the full build and install matrix; when `ci-status` is green, GitHub squash-merges.
3. `release.yml` runs on every push to `main`. It derives the tag with `npm run version -- --print gitTag`. If the tag already exists it stops (docs-only merges never re-release). Otherwise it rebuilds, re-runs the install matrix on the exact artifacts, signs provenance attestations, and creates a GitHub Release (never a prerelease/draft, marked latest) with the `.deb`, `.rpm`, `.AppImage`, `SHA256SUMS`, and finally `latest-linux.yml`.
4. `release.yml` then opens `chore(release): changelog for <tag>` with auto-merge; it is docs-only, so CI runs only the fast path, and the following `release.yml` run skips because the tag exists.

## Version strings

`upstream.json` → `scripts/lib/versions.ts`:

| | Example |
|---|---|
| app / `latest-linux.yml` | `1.0.3-44.1` |
| deb Version | `1.0.3.44-1` |
| rpm Version-Release | `1.0.3.44-1` |
| git tag / release | `v1.0.3.44-1` |

## Shipping a wrapper-only change

Open a PR that increments `wrapper_revision` in `upstream.json` (and adds a `CHANGELOG.md` line under `[Unreleased]`). Merging produces a new tag (`v1.0.3.44-2`) and a release. Merging wrapper changes **without** bumping `wrapper_revision` does not release them.

## Upstream changed Electron

The bot PR will carry `needs-human` with the message `Electron version mismatch: Qwen.exe embeds X, sidecars.json pins Y`. On the bot's branch: update `sidecars.json` (`electron.version`, `electron.url`, `electron.sha256` from the official `SHASUMS256.txt`), update `electronVersion` in `packaging/electron-builder.base.json`, push, remove `needs-human`, add `automerge`, and run `gh pr merge --auto --squash`.

## Patches no longer apply

The bot PR carries `needs-human` with the `git apply` output. Locally on the bot's branch: `npm run patches:dev` (fails), edit `build/app/out/main/index.js`, `npm run patches:export -- 0001` and `-- 0002`, `npm run test:unit`, commit, push.

## Manual re-run

`gh workflow run release.yml` re-evaluates `main`. It is a no-op when the tag exists.

## Partial release recovery

If a release run failed after the tag was created (for example an asset upload failed), the next runs will skip. Recover by deleting both the release and the tag, then re-running:

    gh release delete v1.0.3.44-1 --yes
    git push --delete origin v1.0.3.44-1
    gh workflow run release.yml

The workflow never resumes a partial release on its own.

## Rotating `UPSTREAM_BOT_TOKEN`

Create a fine-grained PAT (owner account) scoped to this repository with Contents: read/write, Pull requests: read/write, Workflows: read/write, no expiry longer than one year. Store it as the Actions secret `UPSTREAM_BOT_TOKEN`. Verify with `gh workflow run upstream-check.yml -f dry_run=true`.
```

- [ ] **Step 2: Write `docs/BRANCH_PROTECTION.md`**

```markdown
# Branch protection and repository settings

These settings live in the GitHub UI, not in YAML. Apply them once; CI cannot enforce them.

## Ruleset `protect-main-and-qa`

Settings → Rules → Rulesets → New branch ruleset:

- Enforcement status: Active
- Target branches: `main` and pattern `qa/**` (the `qa/**` pattern lets the final QA procedure exercise auto-merge on a non-release branch)
- Bypass list: empty
- Rules:
  - [x] Restrict deletions
  - [x] Require a pull request before merging — required approvals: **0**; dismiss stale approvals: off; require review from code owners: off
  - [x] Require status checks to pass — add `ci-status`; "Require branches to be up to date before merging": **off**
  - [x] Block force pushes
  - [ ] Require conversation resolution (off)

## General settings

Settings → General:

- Pull Requests: only **Allow squash merging** enabled; default commit message: "Pull request title and description"
- [x] Allow auto-merge
- [x] Automatically delete head branches

Settings → Actions → General:

- Workflow permissions: "Read and write permissions" is **not** required (workflows declare their own `permissions:`); enable **Allow GitHub Actions to create and approve pull requests**.

Settings → Code security:

- [x] Dependabot alerts, [x] Dependabot security updates
- [x] Private vulnerability reporting (referenced by SECURITY.md)
- CodeQL: "Advanced" (configured by `.github/workflows/codeql.yml`)

## Secrets

Settings → Secrets and variables → Actions:

- `UPSTREAM_BOT_TOKEN` — fine-grained PAT of the repository owner, scoped to this repository: Contents read/write, Pull requests read/write, Workflows read/write. Used by `upstream-check.yml` and by the changelog job of `release.yml`, because PRs and pushes made with the default `GITHUB_TOKEN` do not trigger `ci.yml`, so auto-merge would never see a green `ci-status`.

## Labels

`needs-human`, `automerge`, `upstream-bump`, `dependencies`, `qa-defect` (created by `gh label create` in the CI task; recreate with the same names if the repository is re-created).

## Verification checklist

- `gh api repos/sams-git-195/qwenstudio-linux/rulesets` lists `protect-main-and-qa` with `ci-status` in `required_status_checks`.
- `gh api repos/sams-git-195/qwenstudio-linux -q .allow_auto_merge` prints `true`.
- `gh api repos/sams-git-195/qwenstudio-linux -q '.allow_squash_merge, .allow_merge_commit, .allow_rebase_merge'` prints `true`, `false`, `false`.
- `gh secret list` shows `UPSTREAM_BOT_TOKEN`.
```

- [ ] **Step 3: Commit and open a PR (docs-only fast path)**

```bash
git add docs/RELEASING.md docs/BRANCH_PROTECTION.md
git commit -m "docs: add releasing and branch protection guides" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin HEAD && gh pr create --fill --repo sams-git-195/qwenstudio-linux
```
Expected: on this PR, `build-and-test` is skipped and `ci-status` is green (docs-only detection works).

---

# Workstream E — Governance documents (independent; parallel with A–D)

### Task E1: `LICENSE`, `README.md`, `THIRD_PARTY_NOTICES.md`

**Spec:** §14.

**Files:**
- Create: `LICENSE`, `README.md`, `THIRD_PARTY_NOTICES.md`, `tests/unit/docs.test.ts`

- [ ] **Step 1: Write the failing docs test**

`tests/unit/docs.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

describe("governance documents", () => {
  it("README has the required notices", () => {
    const md = read("README.md");
    for (const s of ["not affiliated", "@ali/aes-tracker", "telemetry", "proprietary", "libfuse2", "--ozone-platform-hint=auto", "SECURITY.md", "CONTRIBUTING.md", "sudo apt install ./", "sudo dnf install ./", "--appimage-extract"]) {
      expect(md, `README.md must mention ${s}`).toContain(s);
    }
  });
  it("LICENSE is MIT for the wrapper only", () => {
    expect(read("LICENSE")).toContain("MIT License");
    expect(read("LICENSE")).toContain("Copyright (c) 2026 sams-git-195");
  });
  it("THIRD_PARTY_NOTICES lists every redistributed component", () => {
    const md = read("THIRD_PARTY_NOTICES.md");
    for (const s of ["Qwen Studio", "Electron 35.1.4", "Chromium", "bun 1.2.10", "uv 0.12.15", "electron-builder"]) expect(md).toContain(s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/docs.test.ts`
Expected: FAIL (files missing).

- [ ] **Step 3: Write `LICENSE`**

```
MIT License

Copyright (c) 2026 sams-git-195

This license applies to the packaging scripts, patches, CI configuration and
documentation in this repository only. It does not apply to Qwen Studio, the
Electron runtime, or the bun and uv binaries that the build downloads and
redistributes; see THIRD_PARTY_NOTICES.md.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Write `README.md`**

```markdown
# Qwen Studio for Linux (unofficial)

[![ci](https://github.com/sams-git-195/qwenstudio-linux/actions/workflows/ci.yml/badge.svg)](https://github.com/sams-git-195/qwenstudio-linux/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/sams-git-195/qwenstudio-linux)](https://github.com/sams-git-195/qwenstudio-linux/releases/latest)
[![license](https://img.shields.io/badge/wrapper%20license-MIT-blue)](LICENSE)

Native Linux packages (`.deb`, `.rpm`, `.AppImage`, x86_64) of **Qwen Studio**, Alibaba's desktop client for [chat.qwen.ai](https://chat.qwen.ai/). Upstream ships Windows and macOS builds only; this project repackages the unmodified upstream application on the official Electron 35.1.4 Linux runtime, with two small patches so it runs on Linux.

> **Not affiliated.** This project is not affiliated with, endorsed by or supported by Alibaba Cloud or the Qwen team. "Qwen" is a trademark of its owner. Report problems with the packaging here; report problems with the app or the service to Alibaba.

## Install

Download from the [latest release](https://github.com/sams-git-195/qwenstudio-linux/releases/latest).

| Format | Command |
|---|---|
| Debian / Ubuntu | `sudo apt install ./qwen-studio_<version>_amd64.deb` |
| Fedora | `sudo dnf install ./qwen-studio-<version>.x86_64.rpm` |
| AppImage | `chmod +x qwen-studio-<version>-x86_64.AppImage && ./qwen-studio-<version>-x86_64.AppImage` |

The AppImage needs `libfuse2` (Ubuntu 22.04+/Debian: `sudo apt install libfuse2`). Without FUSE, run `./qwen-studio-<version>-x86_64.AppImage --appimage-extract` and start `squashfs-root/AppRun`.

Verify downloads with the `SHA256SUMS` asset (`sha256sum -c SHA256SUMS`) or `gh attestation verify <file> --owner sams-git-195`.

## Updates

- **AppImage:** the app checks this repository's releases at startup and via *Check for updates*; it downloads and installs the new AppImage in-app.
- **deb / rpm:** the app only *notifies* you and opens the release page; install the new package with your package manager. No `pkexec`/`sudo` prompts are ever triggered by the app.

## Wayland and X11

The desktop entry launches with `--ozone-platform-hint=auto`, so the app runs natively on Wayland and falls back to X11. Starting `qwen-studio` from a terminal launches without the flag (XWayland/X11).

## Telemetry disclosure

The upstream application bundles Alibaba's analytics library `@ali/aes-tracker` and reports usage events to Alibaba. This project neither adds nor removes telemetry; the app behaves exactly as the Windows build in this respect.

## Licensing

Qwen Studio is proprietary software by Alibaba; your use of it is governed by Alibaba's terms for Qwen Chat (see https://chat.qwen.ai/). Only the packaging scripts, patches and CI in this repository are MIT-licensed (see [LICENSE](LICENSE)). Redistributed components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## How it works

1. The upstream Windows installer is downloaded from `download.qwen.ai` and verified against the SHA-512 pinned in `upstream.json`.
2. `app.asar` is extracted, two patches from `patches/` are applied (Linux platform detection; updater pointed at this repository), and a small notify-only updater module is added.
3. The app is assembled onto the official Electron Linux runtime with Linux builds of `bun` and `uv`/`uvx` (pinned in `sidecars.json`) and packaged with electron-builder.
4. A daily bot checks upstream for new versions and opens an auto-merging pull request; merges to `main` publish releases automatically.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/RELEASING.md](docs/RELEASING.md).

## Building locally

    nvm use && npm ci && npm run build && npm run verify

Requires `7z`, `unzip`, `rpm-build`/`rpm`, `dpkg`, `desktop-file-utils`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for where to report packaging vulnerabilities versus upstream application vulnerabilities.
```

- [ ] **Step 5: Write `THIRD_PARTY_NOTICES.md`**

```markdown
# Third-party notices

The release artifacts redistribute the following components. The MIT license in `LICENSE` covers only this repository's own files.

| Component | Version | License | Notes |
|---|---|---|---|
| Qwen Studio (application, `app.asar`, `resources/i18n`, `resources/assets`) | pinned in `upstream.json` | Proprietary (Alibaba Cloud) | Redistributed unmodified except for the patches in `patches/` and the added `out/main/linux-update.js`. Use is governed by Alibaba's terms for Qwen Chat. Bundles `@ali/aes-tracker` telemetry. |
| Electron 35.1.4 | 35.1.4 | MIT | `LICENSE` from the Electron zip is shipped as `/opt/Qwen Studio/LICENSE`. |
| Chromium (inside Electron) | see Electron | BSD-3-Clause and others | `LICENSES.chromium.html` is shipped next to the Electron binary. |
| bun 1.2.10 (`resources/bun/bun`) | 1.2.10 | MIT | https://github.com/oven-sh/bun |
| uv 0.12.15 (`resources/python/uv`, `uvx`) | 0.12.15 | MIT OR Apache-2.0 | https://github.com/astral-sh/uv |
| electron-builder (build tool, not shipped) | 26.15.3 | MIT | Generates deb/rpm/AppImage and the install scripts. |
| electron-updater (inside `app.asar`) | 6.6.2 | MIT | Bundled by upstream. |

Wrapper build-time dependencies: `npm ls --omit=dev` in this repository (none are shipped).
```

- [ ] **Step 6: Run the test and commit**

Run: `npx vitest run tests/unit/docs.test.ts`
Expected: PASS.

```bash
git add LICENSE README.md THIRD_PARTY_NOTICES.md tests/unit/docs.test.ts
git commit -m "docs: add README, MIT license and third-party notices" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task E2: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`

**Spec:** §14.

**Files:**
- Create: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`

- [ ] **Step 1: Write `CONTRIBUTING.md`**

```markdown
# Contributing

## Development setup

Fedora:

    sudo dnf install -y git nodejs-npm p7zip p7zip-plugins unzip rpm-build dpkg desktop-file-utils cpio xorg-x11-server-Xvfb xorg-x11-xauth curl

Ubuntu/Debian:

    sudo apt install -y git p7zip-full unzip rpm dpkg-dev desktop-file-utils cpio xvfb xauth curl

Node 22 via nvm: `nvm install 22 && nvm use`. Then:

    npm ci
    npm run typecheck && npm run test:unit
    npm run build          # downloads ~330 MB into .cache/ on first run, writes dist/
    npm run verify
    tests/smoke/smoke.sh build/linux-unpacked/qwen-studio build/linux-unpacked/resources

Container install tests (any one leg): `docker run --rm --shm-size=1g -v "$PWD/dist:/dist:ro" -v "$PWD/tests:/tests:ro" ubuntu:24.04 bash /tests/install/install-and-smoke.sh deb`.

## Patches

Patches in `patches/` are unified diffs applied with `git apply` to the unpacked `app.asar`.

1. `npm run patches:dev` — prepares `build/app-pristine/` (untouched) and `build/app/` (patched).
2. Edit `build/app/out/main/index.js`.
3. `npm run patches:export -- 0002` (or `0001`) regenerates the patch file from your edits.
4. `npm run test:unit` — `tests/unit/patch.test.ts` applies the patches to the committed pristine fixture.

Keep patches minimal: only what is required to run on Linux and to point the updater at this repository.

## Commits and pull requests

- Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `build:`, `test:`, `chore:`), enforced by commitlint on PRs; the PR title must also be conventional (squash merges use it).
- Every PR runs unit tests; PRs touching anything besides docs also run the full build and the install matrix. `ci-status` must be green.
- Wrapper changes are released only when `wrapper_revision` in `upstream.json` is incremented (see docs/RELEASING.md).
- No DCO or CLA is required.
```

- [ ] **Step 2: Write `SECURITY.md`**

```markdown
# Security policy

## Supported versions

Only the latest GitHub Release is supported. Older releases are not patched.

## Reporting a vulnerability in the packaging

Problems in this repository's scripts, patches, CI, install scripts, or in how the packages are built and signed: use GitHub's private vulnerability reporting for this repository (Security tab → "Report a vulnerability"). You will get an acknowledgement within 7 days.

## Reporting a vulnerability in Qwen Studio or chat.qwen.ai

This project does not develop the application. Vulnerabilities in the app, its embedded web content, its telemetry, or the Qwen service must be reported to Alibaba Cloud's security team (https://security.alibaba.com/ or the contact published on https://chat.qwen.ai/). Please do not file them here; we cannot fix them and will not accept embargoed details.

## Build integrity

Every release carries SLSA provenance attestations (`gh attestation verify <file> --owner sams-git-195`) and a `SHA256SUMS` asset. The upstream installer is verified against a pinned SHA-512 before it is unpacked.
```

- [ ] **Step 3: Write `CODE_OF_CONDUCT.md`**

Use the Contributor Covenant 2.1 text verbatim from https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md (download with `curl -fsSL https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md -o CODE_OF_CONDUCT.md`) and replace the placeholder contact `[INSERT CONTACT METHOD]` with `samheard95@gmail.com`. Verify: `grep -c 'samheard95@gmail.com' CODE_OF_CONDUCT.md` prints `1` and `grep -c 'INSERT' CODE_OF_CONDUCT.md` prints `0`.

- [ ] **Step 4: Commit**

```bash
git add CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md
git commit -m "docs: add contributing guide, security policy and code of conduct" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task E3: Issue templates, PR template, CODEOWNERS

**Spec:** §14.

**Files:**
- Create: `.github/ISSUE_TEMPLATE/config.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/upstream_bump.yml`, `.github/ISSUE_TEMPLATE/packaging.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS`

- [ ] **Step 1: Write the templates**

`.github/ISSUE_TEMPLATE/config.yml`:
```yaml
blank_issues_enabled: false
contact_links:
  - name: Problems with Qwen Chat itself
    url: https://chat.qwen.ai/
    about: This repository only packages the app for Linux. Report application or service problems to Alibaba.
```

`.github/ISSUE_TEMPLATE/bug_report.yml`:
```yaml
name: Bug report
description: The Linux package misbehaves (install, launch, crash, updater)
labels: [bug]
body:
  - type: checkboxes
    attributes:
      label: Acknowledgement
      options:
        - label: I understand this is unofficial packaging, not affiliated with Alibaba.
          required: true
  - type: dropdown
    attributes:
      label: Package format
      options: [deb, rpm, AppImage]
    validations: { required: true }
  - type: input
    attributes:
      label: Distribution and version
      placeholder: Ubuntu 24.04 / Fedora 41
    validations: { required: true }
  - type: dropdown
    attributes:
      label: Session type
      options: [Wayland, X11, unsure]
  - type: input
    attributes:
      label: App version (Help/About or `dpkg -s qwen-studio` / `rpm -q qwen-studio`)
    validations: { required: true }
  - type: textarea
    attributes:
      label: Steps to reproduce
    validations: { required: true }
  - type: textarea
    attributes:
      label: Output of running the app from a terminal
      description: "`ELECTRON_ENABLE_LOGGING=1 qwen-studio` (or the AppImage) — paste the output"
      render: shell
```

`.github/ISSUE_TEMPLATE/upstream_bump.yml`:
```yaml
name: Upstream bump problem
description: A new upstream version failed to package (used by humans and by the bot)
labels: [upstream-bump]
body:
  - type: input
    attributes:
      label: Upstream version and build
      placeholder: 1.0.4.12
    validations: { required: true }
  - type: input
    attributes:
      label: Feed URL
      value: https://download.qwen.ai/windows/x64/latest.yml
  - type: dropdown
    attributes:
      label: What failed
      options: [patch does not apply, Electron version changed, installer download/verification, other]
    validations: { required: true }
  - type: textarea
    attributes:
      label: Logs
      render: shell
```

`.github/ISSUE_TEMPLATE/packaging.yml`:
```yaml
name: Packaging problem
description: Dependencies, desktop entry, icons, file layout
labels: [packaging]
body:
  - type: dropdown
    attributes:
      label: Package format
      options: [deb, rpm, AppImage]
    validations: { required: true }
  - type: input
    attributes:
      label: Distribution and version
    validations: { required: true }
  - type: dropdown
    attributes:
      label: Area
      options: [dependencies, desktop entry / menu, icon, file layout / permissions, uninstall, other]
    validations: { required: true }
  - type: textarea
    attributes:
      label: Details and output of `dpkg -s qwen-studio` or `rpm -qi qwen-studio`
      render: shell
```

`.github/PULL_REQUEST_TEMPLATE.md`:
```markdown
## Summary

<!-- What and why -->

## Checklist

- [ ] PR title follows Conventional Commits (it becomes the squash commit message)
- [ ] Unit tests added or updated (`npm run test:unit`)
- [ ] Docs updated (README / docs/ARCHITECTURE.md / CHANGELOG.md `[Unreleased]`) where behaviour changed
- [ ] `npm run build && npm run verify` passes locally, or I rely on CI's build-and-test job
- [ ] If this should ship to users, `wrapper_revision` in `upstream.json` is incremented
```

`.github/CODEOWNERS`:
```
* @sams-git-195
```

- [ ] **Step 2: Commit and open a PR; check the templates render**

```bash
git add .github/ISSUE_TEMPLATE .github/PULL_REQUEST_TEMPLATE.md .github/CODEOWNERS
git commit -m "docs: add issue and PR templates and CODEOWNERS" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin HEAD && gh pr create --fill --repo sams-git-195/qwenstudio-linux
```
After merge, open https://github.com/sams-git-195/qwenstudio-linux/issues/new/choose — expected: three templates plus the contact link; the PR body of the next PR shows the checklist.

---

### Task E4: `docs/ARCHITECTURE.md`

**Spec:** §14, summarising §3.4, §7, §8, §9, §10.

**Files:**
- Create: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Write the document**

```markdown
# Architecture

## Pipeline

    upstream.json + sidecars.json
            │
    fetch   │  download installer (SHA-512) + Electron/bun/uv (SHA-256) into .cache/
            ▼
    extract │  7z installer → $PLUGINSDIR/app-64.7z → build/win-app; asar → build/app-pristine, build/app
            ▼
    patch   │  git apply patches/*.patch to build/app; add out/main/linux-update.js; set package.json version
            ▼
    assemble│  Electron zip + app.asar + assets + i18n + bun + uv/uvx → build/linux-unpacked (binary renamed qwen-studio)
            ▼
    icons   │  resources/assets/icon.png → build/icons/{16..512}.png
            ▼
    package │  per target: copy to build/stage-<t>, electron-builder --prepackaged → dist/
            ▼
    verify  │  control fields, payload paths, desktop entries, latest-linux.yml, no package-type in AppImage

Every stage is `scripts/<stage>.ts`; `scripts/build.ts` runs them in order (`--until <stage>` stops early). Shared helpers live in `scripts/lib/`.

## Why a separate electron-builder invocation per target

electron-builder's deb/rpm target writes `resources/package-type` and `resources/app-update.yml` into the prepackaged directory. `package-type` makes electron-updater switch to `DebUpdater`/`RpmUpdater` (which install with `pkexec`). If the AppImage were packed from the same directory after the deb, it would carry `package-type=deb` and break in-app updates. Each target therefore gets its own copy of `build/linux-unpacked` and its own output directory; only the AppImage run's `latest-linux.yml` is published.

## Patches

| Patch | Purpose |
|---|---|
| `0001-linux-platform-dir.patch` | `getPlatformDir()` returned only mac/win values and threw `Unsupported platform` on Linux. |
| `0002-linux-updater.patch` | On Linux: use the GitHub provider (`sams-git-195/qwenstudio-linux`), set `allowPrerelease=false`, set `autoInstallOnAppQuit` only for AppImage, and route deb/rpm installs to the notify-only module. |

`src/app/linux-update.js` is copied into the asar as `out/main/linux-update.js` by the patch stage. Maintenance: `npm run patches:dev`, edit `build/app/out/main/index.js`, `npm run patches:export -- <NNNN>`, `npm run test:unit` (the pristine fixture `tests/fixtures/app-pristine/out/main/index.js` is refreshed by the bot on every bump).

## Updater design (verified against electron-updater 6.6.2 bundled upstream)

- `AppUpdater` sets `allowPrerelease=true` when the app version has prerelease identifiers (ours always do: `1.0.3-44.1`). With that setting the GitHub provider matches release tags by "channel" (`44`) and skips non-semver tags such as `v1.0.3.44-1`, so nothing is ever found. Patch 0002 sets `allowPrerelease=false`; the provider then uses `/releases/latest` → `latest-linux.yml` → `semver.gt`. Releases must be normal (not prerelease) and marked latest.
- `AppImageUpdater.isUpdaterActive()` is false without `APPIMAGE`; `checkForUpdates()` resolves `null` without events, so deb/rpm installs would silently never notify. `linux-update.js` fetches `releases/latest/download/latest-linux.yml`, compares with `semver`, and shows the upstream dialog strings with "Download now" opening the releases page. It never installs anything.

## Version scheme

| Field | Example | Consumer |
|---|---|---|
| `appVersion` | `1.0.3-44.1` | asar `package.json`, `latest-linux.yml`, electron-updater ordering |
| `debVersion` | `1.0.3.44-1` | deb `Version` (via `fpm --version 1.0.3.44 --iteration 1`) |
| `rpmVersion` / `rpmRelease` | `1.0.3.44` / `1` | rpm |
| `gitTag` | `v1.0.3.44-1` | git tag, GitHub Release |

`wrapper_revision` is reset to 1 on every upstream bump and incremented for wrapper-only releases.

## Launcher and sandbox

electron-builder's stock post-install links `/usr/bin/qwen-studio` → `/opt/Qwen Studio/qwen-studio`, sets `chrome-sandbox` to 4755 only where user namespaces are unavailable, and installs an AppArmor profile on Ubuntu 24.04+. `--ozone-platform-hint=auto` is placed in the desktop entry via `linux.executableArgs`. `--no-sandbox` is used only by `tests/smoke/smoke.sh` inside containers.

## CI

`ci.yml` (PRs and main) → `lint-unit` always; `build-and-test.yml` (reusable: build, verify, lintian/rpmlint, appimagelint advisory, 7-leg Docker install matrix) unless the change is docs-only; `ci-status` is the single required check. `release.yml` publishes on merge to `main` when the derived tag does not exist yet. `upstream-check.yml` is the daily bot. See docs/RELEASING.md and docs/BRANCH_PROTECTION.md.

## Package linters

lintian runs with `packaging/lintian/qwen-studio.overrides` and `--fail-on error`; rpmlint with `packaging/rpmlint/qwen-studio.toml` and must report 0 errors. Only findings inherent to the verbatim Electron/upstream payload are suppressed; each suppression carries a justification comment.
```

- [ ] **Step 2: Commit and open a PR**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: add architecture overview" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin HEAD && gh pr create --fill --repo sams-git-195/qwenstudio-linux
```

---

# Workstream F — Final QA (serial, last)

### Task F1: Final QA by a Fable 5.1 medium-effort review agent

**Spec:** §16 (authoritative; this task restates it as commands). Preconditions: A–E merged; the owner applied every item in `docs/BRANCH_PROTECTION.md`; `UPSTREAM_BOT_TOKEN` exists; at least one release exists.

**Files:**
- Create: none in the repository; the agent writes a QA report issue and `qa-defect` issues. Fixes go through normal PRs.

**Interfaces:**
- Consumes everything. Exit criterion: all 13 steps pass on one commit of `main`; the QA report issue is closed with that SHA.

- [ ] **Step 1: Open the report issue**

Run: `gh issue create --repo sams-git-195/qwenstudio-linux --title "QA: final review $(date -u +%F)" --label qa-defect --body "Tracking issue for the final QA pass. Each step below is appended as a comment with the exact command and outcome."`

- [ ] **Step 2: Clean clone and hygiene**

```bash
rm -rf /tmp/qa && git clone https://github.com/sams-git-195/qwenstudio-linux.git /tmp/qa && cd /tmp/qa
git status --short | wc -l            # expected 0
git ls-files | grep -E '\.exe$' | wc -l   # expected 0
```

- [ ] **Step 3: Unit and typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use && npm ci && npm run typecheck && npm run test:unit
```
Expected: all pass.

- [ ] **Step 4: Build and verify**

```bash
npm run build && npm run verify && ls dist/
```
Expected: `verify` passes; `dist/` holds exactly the four files.

- [ ] **Step 5: Linters**

```bash
docker run --rm -v "$PWD/dist:/dist:ro" -v "$PWD/packaging:/packaging:ro" debian:12 bash -c 'apt-get update -qq && apt-get install -y -qq lintian >/dev/null && lintian --suppress-tags-from-file /packaging/lintian/qwen-studio.overrides --fail-on error /dist/*.deb'
docker run --rm -v "$PWD/dist:/dist:ro" -v "$PWD/packaging:/packaging:ro" fedora:41 bash -c 'dnf install -y -q rpmlint >/dev/null && rpmlint -c /packaging/rpmlint/qwen-studio.toml /dist/*.rpm'
```
Expected: exit 0 and `0 errors`.

- [ ] **Step 6: Seven fresh containers**

```bash
for leg in "ubuntu:22.04 deb" "ubuntu:24.04 deb" "debian:12 deb" "fedora:40 rpm" "fedora:41 rpm" "ubuntu:22.04 appimage" "fedora:41 appimage"; do
  set -- $leg
  docker run --rm --shm-size=1g -v "$PWD/dist:/dist:ro" -v "$PWD/tests:/tests:ro" "$1" bash /tests/install/install-and-smoke.sh "$2" || { echo "LEG FAILED: $leg"; exit 1; }
done
```
Expected: seven `INSTALL+SMOKE PASS` lines.

- [ ] **Step 7: Released artifacts match and are attested**

```bash
TAG=$(npm run -s version -- --print gitTag)
rm -rf /tmp/rel && gh release download "$TAG" --repo sams-git-195/qwenstudio-linux -D /tmp/rel
(cd /tmp/rel && sha256sum -c SHA256SUMS)
for f in /tmp/rel/*.deb /tmp/rel/*.rpm /tmp/rel/*.AppImage; do gh attestation verify "$f" --owner sams-git-195; done
gh release view "$TAG" --repo sams-git-195/qwenstudio-linux --json isPrerelease,isDraft,isLatest -q '[.isPrerelease,.isDraft,.isLatest]'
```
Expected: checksums OK; three attestation verifications succeed; prints `[false,false,true]`.

- [ ] **Step 8: AppImage updater path (real runtime, needs FUSE on the host)**

```bash
cd /tmp/qa && cp upstream.json /tmp/upstream.bak && sed -i 's/"wrapper_revision": [0-9]*/"wrapper_revision": 0/' upstream.json
sed -i 's/(o.wrapper_revision as number) < 1/(o.wrapper_revision as number) < 0/' scripts/lib/manifest.ts   # temporary, QA only
npm run build -- --until package
OLD=$(ls dist/*.AppImage)
HOME=$(mktemp -d) ELECTRON_ENABLE_LOGGING=1 timeout 60 "$OLD" > /tmp/qa-appimage.log 2>&1 || true
grep -E "Checking for updates|Update available:" /tmp/qa-appimage.log
grep -cE "ERR_UPDATER_NO_PUBLISHED_VERSIONS|ERR_UPDATER_INVALID_VERSION" /tmp/qa-appimage.log
git checkout -- upstream.json scripts/lib/manifest.ts
```
Expected: `Checking for updates...` and `Update available:` containing the released `appVersion`; the error grep prints `0`. (If a previous release exists, run that release's AppImage instead of building a revision-0 one.)

- [ ] **Step 9: deb notify-only path**

```bash
# dist/ still holds the revision-0 packages built in step 8 (git checkout does not touch dist/); use that dist/*.deb
docker run --rm --shm-size=1g -v "$PWD/dist:/dist:ro" -v "$PWD/tests:/tests:ro" ubuntu:24.04 bash -c '
  export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq xvfb xauth curl ca-certificates procps desktop-file-utils /dist/qwen-studio_*.deb >/dev/null
  SMOKE_KEEP_RUNNING=1 SMOKE_LOG=/tmp/smoke.log bash /tests/smoke/smoke.sh "/opt/Qwen Studio/qwen-studio" "/opt/Qwen Studio/resources"
  sleep 10; grep -E "\[linux-update\] update available" /tmp/smoke.log; grep -c pkexec /tmp/smoke.log || true'
```
Expected: `[linux-update] update available <released appVersion>` printed; `pkexec` count `0`.

- [ ] **Step 10: Upstream-bump simulation on `qa/bump-sim`**

```bash
cd /tmp/qa && git checkout -b qa/bump-sim main
sed -i 's/"build": 44/"build": 43/; s/1\.0\.3\.44-release/1.0.3.43-release/' upstream.json
git commit -am "chore(qa): simulate an older upstream state" && git push -u origin qa/bump-sim
gh workflow run upstream-check.yml --repo sams-git-195/qwenstudio-linux -f base_branch=qa/bump-sim
sleep 600
gh pr list --repo sams-git-195/qwenstudio-linux --head upstream/qa/bump-sim/v1.0.3.44 --json number,labels,autoMergeRequest,state
```
Expected: one PR targeting `qa/bump-sim`, labels `upstream-bump` and `automerge`, `autoMergeRequest` non-null; after CI (`gh pr checks <n> --watch`) it is merged; `git show origin/qa/bump-sim:upstream.json` shows build 44 and `wrapper_revision: 1`; `gh release list` shows no new release. Then `git push --delete origin qa/bump-sim`.

- [ ] **Step 11: Bot failure path**

```bash
gh workflow run upstream-check.yml --repo sams-git-195/qwenstudio-linux -f base_branch=main -f feed_url=https://raw.githubusercontent.com/sams-git-195/qwenstudio-linux/main/tests/fixtures/latest-bad-filename.yml
sleep 120
gh issue list --repo sams-git-195/qwenstudio-linux --label needs-human --search "Upstream bot failure" --json title,state
gh run list --repo sams-git-195/qwenstudio-linux --workflow upstream-check --limit 1 --json conclusion -q '.[0].conclusion'
```
Expected: an open issue `Upstream bot failure: cannot read or parse the upstream feed`; run conclusion `failure`; no new PR. Close the issue afterwards with a comment `QA simulation`.

- [ ] **Step 12: Docs-only merge**

```bash
git checkout -b qa/docs-only main && printf '\n<!-- qa docs-only check -->\n' >> README.md && git commit -am "docs: qa docs-only check" && git push -u origin qa/docs-only
gh pr create --fill --repo sams-git-195/qwenstudio-linux --label automerge && gh pr merge --auto --squash
```
Expected: `ci` run shows `build-and-test` skipped and `ci-status` success; after merge the `release` run's `plan` job logs `Tag v... already exists; nothing to release`.

- [ ] **Step 13: Public-repo checklist**

Verify and record each: README notices (non-affiliation, telemetry, license pointer); SECURITY.md two channels; issue templates render at `/issues/new/choose`; `gh api repos/sams-git-195/qwenstudio-linux/codeowners/errors` returns no errors; Dependabot and CodeQL enabled and their last runs green; `gh api repos/sams-git-195/qwenstudio-linux -q .allow_auto_merge` is `true`; ruleset lists `ci-status`; `gh secret list` shows `UPSTREAM_BOT_TOKEN`.

- [ ] **Step 14: Deep link**

```bash
docker run --rm --shm-size=1g -v "$PWD/dist:/dist:ro" -v "$PWD/tests:/tests:ro" ubuntu:24.04 bash -c '
  export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq xvfb xauth curl ca-certificates procps desktop-file-utils /dist/qwen-studio_*.deb >/dev/null
  eval "$(SMOKE_KEEP_RUNNING=1 SMOKE_LOG=/tmp/smoke.log bash /tests/smoke/smoke.sh "/opt/Qwen Studio/qwen-studio" "/opt/Qwen Studio/resources" | grep -E "^SMOKE_(PID|HOME)=")"
  HOME="$SMOKE_HOME" xvfb-run -a "/opt/Qwen Studio/qwen-studio" --no-sandbox "qwen://open?token=test" >/dev/null 2>&1 || true
  sleep 5; grep -E "second-instance" /tmp/smoke.log; grep -c "qwen://open?token=test" /tmp/smoke.log
  xdg-mime query default x-scheme-handler/qwen'
```
Expected: `second-instance` line present (upstream calls `app.requestSingleInstanceLock()`, so the second process hands its argv to the first); count ≥ 1; `qwen-studio.desktop`.

- [ ] **Step 15: Defects and closure**

For every failed step: `gh issue create --label qa-defect --title "QA: <step> failed: <symptom>" --body "<command, output, expected>"`, fix via PR, and re-run that step (and step 4–6 if the fix touched the build). When all 13 steps pass on the same `main` SHA: `gh issue close <report> --comment "All QA steps passed on $(git rev-parse HEAD)"`.

---

## Plan self-review notes

- Spec coverage: §5 → A1; §6 → A2; §7 → A3; §10.1 → A4; §10.2 → A5; §8.3 → A6; §8.1/8.2/8.4/10.3 → A7; §10.4/10.5 → A8; §10.6 → A9+B1+B2; §10.7 → B1+B4; §10.8 → B3; §11.3 → B5+C3; §11.5 → C1; §11.4 → C2+C3; §12.1 → C3; §12.2 → C4; §11.6 → C4+C5; §12.4 → D1+D2; §12.3 → D3+D4; §13 → D5; §14 → E1–E4 (+D5); §16 → F1.
- Names used across tasks: `deriveVersions`, `DerivedVersions`, `readUpstream`, `readSidecars`, `parseFeed`, `validateUpstream`, `fetchCached`, `run`, `sha256File`, `sha512Base64File`, `extractAll`, `detectElectronVersion`, `applyPatches`, `finishPatchStage`, `exportPatch`, `assemble`, `renderIcons`, `ICON_SIZES`, `STAGES`, `selectStages`, `runStages`, `buildConfig`, `packageTarget`, `packageAll`, `TARGETS`, `verifyAll`, `parseDesktopEntry`, `assertDesktop`, `addUnreleased`, `finalize`, `unreleasedSection`, `renderReleaseHeader`, `compareUpstream`, `branchName`, `nextManifest`, `renderPrBody`, `writeVersionJson` — each defined in exactly one task and referenced with the same signature elsewhere.
