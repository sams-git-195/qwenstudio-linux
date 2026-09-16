# Qwen Studio for Linux — Design Specification

Date: 2026-09-15
Status: Approved for implementation
Repository: https://github.com/sams-git-195/qwenstudio-linux (branch `main`)

## 1. Summary

Qwen Studio is Alibaba's proprietary Electron desktop client for https://chat.qwen.ai/ ("Qwen Chat"). Upstream ships a Windows NSIS installer and macOS builds only. This project repackages the **unmodified upstream application code** (with two small, version-controlled patches) on top of the **official Electron 35.1.4 linux-x64 runtime**, adds the Linux builds of the two sidecar tools the app spawns (bun, uv/uvx), and ships native Linux packages:

- `qwen-studio_<ver>_amd64.deb`
- `qwen-studio-<ver>.x86_64.rpm`
- `qwen-studio-<ver>-x86_64.AppImage`

The repository contains **only** scripts, patches, manifests, packaging metadata, CI and docs. The upstream installer is downloaded at build time from `download.qwen.ai` and verified by SHA-512. GitHub Releases redistribute the resulting packages. Upstream version tracking is fully automatic (daily poll → PR → green CI → auto-merge → release).

Approach A ("native Electron repack") was chosen. Wine is not used.

## 2. Goals and non-goals

### Goals

1. `.deb`, `.rpm` and `.AppImage` for x86_64 that install and launch on Ubuntu 22.04/24.04, Debian 12, Fedora 40/41 and any glibc ≥ 2.31 distro (AppImage).
2. Reproducible, single-command build: `npm ci && npm run build`.
3. Professional public GitHub repository: CI on every PR, install/launch test matrix, security scanning, release automation, governance documents.
4. Fully automatic upstream tracking with no human in the loop when everything is green.
5. In-app updates: AppImage users get full in-app update via electron-updater from our GitHub Releases; deb/rpm users get a notification with a link to the release page.
6. Final QA performed by an automated review agent following an explicit script (Section 16).

### Non-goals

- arm64 or any non-x86_64 architecture.
- Modifying application behaviour beyond what is required to run on Linux (Section 8).
- Removing or altering upstream telemetry (`@ali/aes-tracker`); it is disclosed, not stripped.
- Flatpak or Snap packaging.
- Tests that require a Qwen account or interact with the logged-in UI.
- Wine-based execution.

## 3. Ground truth about upstream (verified 2026-09-15)

These facts were verified by direct inspection and are treated as fixed inputs. Scripts must not re-derive them at runtime except where stated.

### 3.1 Installer and update feed

- Feed: `https://download.qwen.ai/windows/x64/latest.yml` (HTTP 200). Current content:
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
- Installer URL: `https://download.qwen.ai/windows/x64/<files[0].url>`.
- The `sha512` in the feed **matches** the actual file. The `size` in the feed (124943360) does **not** match the actual file (124954112 bytes, confirmed by `Content-Length` and local file). Consequence: verification is by SHA-512 only; `size` is recorded but never enforced (a mismatch produces a warning line, not a failure).
- Old installers may disappear from the CDN. Each `upstream.json` revision pins `url` + `sha512`; if the CDN drops a file, older tags simply become unbuildable. This is accepted.
- The installer is an electron-builder NSIS installer. `7z x` yields `$PLUGINSDIR/app-64.7z`; extracting that yields the Electron app directory.

### 3.2 Application layout inside `app-64.7z`

```
Qwen.exe, *.dll, *.pak, locales/, LICENSE.electron.txt, LICENSES.chromium.html, ...
resources/
  app.asar              (16 MB; the application)
  app-update.yml        (Windows generic-provider updater config; unused by our build)
  assets/icon.png, assets/icon_dark.png
  bun/bun.exe           (bun 1.2.10, Windows)
  python/uv.exe, python/uvx.exe
  elevate.exe           (Windows-only helper, unreferenced by app code; dropped)
  i18n/{ar-BH,de-DE,en-US,es-ES,fr-FR,it-IT,ja-JP,ko-KR,pt-PT,ru-RU,zh-CN,zh-TW}.json
```

- Electron version: **35.1.4**. Official runtime: `https://github.com/electron/electron/releases/download/v35.1.4/electron-v35.1.4-linux-x64.zip`; checksums: `https://github.com/electron/electron/releases/download/v35.1.4/SHASUMS256.txt`.
- `app.asar` contains `package.json` (name `Qwen`, version `1.0.3`, main `./out/main/index.js`), `out/main/index.js` (22.7 KB, unminified), `out/preload/index.js`, `out/renderer/{index.html,assets/*}`, `node_modules/`. There are **no native `.node` modules**. Bundled `electron-updater` is **6.6.2**; bundled `semver` is **7.7.2**; `js-yaml` is present.
- Renderer: `out/renderer/index.html` is loaded via `loadFile`; it hosts a `<webview>` that loads `https://chat.qwen.ai/`.

### 3.3 Relevant main-process code (`out/main/index.js`)

- `getPlatformDir()` returns `mac-arm64|mac-x64|win-x64` and **throws `Unsupported platform: linux, arch: x64`** otherwise. Only the dev-mode path uses the platform dir; the packaged path is `path.join(process.resourcesPath, type, binName)`. So the packaged layout must be `resources/bun/bun` and `resources/python/uv`, `resources/python/uvx`.
- `getBunPath()` → `bun.exe` on win32 else `bun`; `getUvxPath()` → `uvx.exe` on win32 else `uvx`.
- `initializeAutoUpdater()` sets `autoDownload=false`, `autoInstallOnAppQuit=true`, `updateConfigPath=null`, and calls `setFeedURL({provider:"generic", url: "https://download.qwen.ai/" + platformSpecificPath})` where `platformSpecificPath` is empty on Linux. It registers handlers for `update-available` (dialog: download now / later → `downloadUpdate()`), `update-not-available`, `download-progress`, `update-downloaded` (dialog: install now / later → `quitAndInstall()`), `error`.
- `checkForUpdates()` (menu item "Check for updates") and `autoUpdate()` (called once at startup) both call `initializeAutoUpdater()` then `electronUpdater.autoUpdater.checkForUpdates()`.
- `app.setAsDefaultProtocolClient("qwen")`; `open-url` and `second-instance` handlers parse `qwen://` URLs. A `win32`-only argv parser exists; Linux relies on `second-instance`, which is correct as-is.
- `window-all-closed` calls `app.quit()` on non-darwin. The `close-window` IPC calls `mainWindow.close()` on non-darwin; there is no `close` interception, so closing the main window exits the process.
- i18n keys used by the updater dialogs exist in every `resources/i18n/*.json`: `update.new_version_found`, `update.new_version_message` (`{{version}}`), `update.download_now`, `update.later`, `update.latest_version` (`{{version}}`), `update.install_update`, `update.download_complete`, `update.install_detail`, `update.install_now`, `update.install_later`, `menu.check_update`.

### 3.4 Verified electron-updater 6.6.2 behaviour (drives Section 9)

- On Linux `electron-updater` instantiates `AppImageUpdater`, unless `process.resourcesPath/package-type` exists and contains `deb`/`rpm`/`pacman`, in which case `DebUpdater`/`RpmUpdater`/`PacmanUpdater` is used. electron-builder's fpm target **writes `resources/package-type` and `resources/app-update.yml` into the prepackaged directory** when a `publish` configuration is present.
- `AppImageUpdater.isUpdaterActive()` returns `false` when `process.env.APPIMAGE` is unset; `checkForUpdates()` then resolves `null` and emits **no event**.
- `DebUpdater`/`RpmUpdater` install by running `pkexec`/`sudo` (`dpkg -i` / `rpm -U`) on `quitAndInstall()` or on quit when `autoInstallOnAppQuit` is true.
- `AppUpdater` constructor sets `allowPrerelease = true` whenever the current version has prerelease components. With `allowPrerelease = true` the GitHub provider treats the first prerelease identifier of the current version as a "channel" and only accepts release tags whose first prerelease identifier matches; tags that are not valid semver are skipped. For our version scheme (`1.0.3-44.1`, channel `44`) and tag scheme (`v1.0.3.44-1`, not semver) this yields `ERR_UPDATER_NO_PUBLISHED_VERSIONS`. With `allowPrerelease = false` the provider fetches `https://github.com/<owner>/<repo>/releases/latest` (JSON, `tag_name`), downloads `releases/download/<tag>/latest-linux.yml`, and compares `version` from that YAML to the current version with `semver.gt`. Prerelease identifiers are compared numerically by semver, so `1.0.3-44.1 < 1.0.3-44.2 < 1.0.3-45.1 < 1.0.4-1.1` and `1.0.3-99.1 < 1.0.3-100.1`.
- Consequences: (a) patch 2 must set `allowPrerelease = false`; (b) GitHub Releases must be published as normal (not prerelease, not draft) releases and marked "latest"; (c) the channel file name on linux-x64 is exactly `latest-linux.yml`.
- `AppUpdater` can be instantiated in plain Node with a fake `AppAdapter` (constructor signature `(options, app)`); `require("electron")` is only evaluated lazily inside methods we do not call. This makes `isUpdateAvailable()` unit-testable.

### 3.5 Spike result (local, Fedora 44)

Electron 35.1.4 linux-x64 zip + `resources/default_app.asar` removed + binary renamed `electron` → `qwen-studio` (required so `app.isPackaged === true`) + `app.asar` with patch 1 + `assets/`, `i18n/`, linux `bun`, `uv`, `uvx` → launched with `--remote-debugging-port=9333`; `curl http://127.0.0.1:9333/json` returned a `page` target (`file:///.../out/renderer/index.html`) and a `webview` target (`https://chat.qwen.ai/`). No "Unsupported platform" error. This is the CI smoke-test assertion (Section 11.5).

## 4. Naming and identifiers (fixed)

| Item | Value |
|---|---|
| Package name (deb, rpm, npm) | `qwen-studio` |
| Executable | `qwen-studio` |
| productName | `Qwen Studio` |
| appId | `ai.qwen.studio` |
| Install prefix (deb/rpm) | `/opt/Qwen Studio/` (electron-builder default `/opt/<productName>`) |
| Desktop file | `/usr/share/applications/qwen-studio.desktop` |
| Desktop categories | `Network;Chat;` |
| Desktop `MimeType` | `x-scheme-handler/qwen;` |
| Desktop `StartupWMClass` | `Qwen Studio` |
| URL scheme | `qwen` |
| Icons | `/usr/share/icons/hicolor/<N>x<N>/apps/qwen-studio.png` for N in 16, 24, 32, 48, 64, 128, 256, 512 |
| GitHub owner/repo | `sams-git-195` / `qwenstudio-linux` |
| Wrapper license | MIT |

## 5. Repository layout

```
.github/
  CODEOWNERS
  PULL_REQUEST_TEMPLATE.md
  dependabot.yml
  ISSUE_TEMPLATE/{config.yml,bug_report.yml,upstream_bump.yml,packaging.yml}
  workflows/{ci.yml,build-and-test.yml,release.yml,upstream-check.yml,codeql.yml}
docs/
  ARCHITECTURE.md  RELEASING.md  BRANCH_PROTECTION.md
  superpowers/specs/  superpowers/plans/
packaging/
  electron-builder.base.json      # static part of the electron-builder config
  lintian/qwen-studio.overrides   # lintian overrides (Section 11.3)
  rpmlint/qwen-studio.toml        # rpmlint config (Section 11.3)
patches/
  0001-linux-platform-dir.patch
  0002-linux-updater.patch
src/app/
  linux-update.js                 # copied into app.asar as out/main/linux-update.js
scripts/
  fetch.ts  extract.ts  patch.ts  assemble.ts  build.ts  version.ts  verify.ts
  icons.ts  upstream-check.ts  changelog.ts
  lib/{paths.ts,download.ts,hash.ts,manifest.ts,versions.ts,exec.ts,electron-builder-config.ts}
tests/
  unit/*.test.ts                  # vitest
  smoke/smoke.sh                  # headless launch assertions
  install/install-and-smoke.sh    # run inside a distro container
  fixtures/                       # small fixtures (feed yml samples, fake asar tree)
upstream.json  sidecars.json  package.json  package-lock.json  tsconfig.json
vitest.config.ts  commitlint.config.cjs  .gitignore  .editorconfig  .nvmrc
README.md  LICENSE  THIRD_PARTY_NOTICES.md  CONTRIBUTING.md  SECURITY.md
CODE_OF_CONDUCT.md  CHANGELOG.md
```

Generated/ignored directories: `.cache/` (downloads), `build/` (all intermediate output), `dist/` (packages), `node_modules/`. `.gitignore` must contain `*.exe`, `.cache/`, `build/`, `dist/`, `node_modules/`, `*.log`. The file `Qwen-1.0.3.44-release-win-x64.exe` currently in the working tree is untracked and must never be committed; the first implementation commit adds `.gitignore` with `*.exe`.

`directories.buildResources` in electron-builder is set explicitly to `packaging` and `directories.output` to a per-target directory under `dist/` (Section 10.6) so electron-builder never treats `build/` as its resources directory.

## 6. Manifests

### 6.1 `upstream.json`

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

- `version`: upstream semver core from the feed (`version:`).
- `build`: integer parsed from the installer filename with `^Qwen-(\d+\.\d+\.\d+)\.(\d+)-release-win-x64\.exe$` (group 2). Group 1 must equal `version`; otherwise the bot fails with `needs-human` (Section 12.3).
- `wrapper_revision`: positive integer. Reset to `1` by the bot on every upstream bump; incremented manually (via PR) when wrapper-only changes must ship a new release.
- `sha512`: base64 as given by the feed. Verified against the downloaded file (mandatory).
- `size`: actual byte size recorded by the bot after download (informational; a feed `size` mismatch only logs a warning).
- `releaseDate`: copied from the feed.

`scripts/lib/manifest.ts` validates the shape (all fields present, types correct, `sha512` is 88-char base64, `url` starts with `https://download.qwen.ai/`) and throws on any violation.

### 6.2 `sidecars.json`

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

Notes:
- The `sha256` values above were taken on 2026-09-15 from the official checksum files (`SHASUMS256.txt` for electron and bun; `uv-x86_64-unknown-linux-gnu.tar.gz.sha256` for uv) and are the values to commit. The implementation task re-downloads the checksum files and must obtain identical values.
- `extract` maps the destination basename to the path inside the archive. `scripts/extract.ts` fails with exit 4 if an `extract` source path does not exist in the archive (the uv tarball's top-level directory is `uv-x86_64-unknown-linux-gnu/`).
- `bun-linux-x64-baseline` (no AVX2 requirement) is chosen deliberately for compatibility with older CPUs.
- The URL must contain an explicit version tag; a URL containing `/latest/` is rejected by manifest validation.
- Electron version must equal the version detected from the upstream app (the electron-builder config's `electronVersion` is set from this manifest). Upstream bumps that change Electron require a manual `sidecars.json` update; the bot detects this (Section 12.3, check 4) and labels `needs-human`.

## 7. Versioning

One pure function, `deriveVersions(upstream: UpstreamManifest): DerivedVersions` in `scripts/lib/versions.ts`, is the single source of truth. Given `{ version: "1.0.3", build: 44, wrapper_revision: 1 }` it returns:

| Field | Value | Used for |
|---|---|---|
| `appVersion` | `1.0.3-44.1` | `package.json` version inside `app.asar`; electron-builder `extraMetadata.version`; `latest-linux.yml` `version` |
| `upstreamLabel` | `1.0.3.44` | human-readable upstream identifier |
| `debVersion` | `1.0.3.44-1` | deb `Version` field |
| `rpmVersion` | `1.0.3.44` | rpm `Version` |
| `rpmRelease` | `1` | rpm `Release` |
| `gitTag` | `v1.0.3.44-1` | git tag and GitHub Release tag |
| `releaseName` | `Qwen Studio 1.0.3.44 (linux-1)` | GitHub Release title |
| `artifacts.deb` | `qwen-studio_1.0.3.44-1_amd64.deb` | |
| `artifacts.rpm` | `qwen-studio-1.0.3.44-1.x86_64.rpm` | |
| `artifacts.appImage` | `qwen-studio-1.0.3.44-1-x86_64.AppImage` | |

Rules:
- `appVersion = ${version}-${build}.${wrapper_revision}` — a semver prerelease, so `electron-updater`/`semver` orders every release: `1.0.3-44.1 < 1.0.3-44.2 < 1.0.3-45.1 < 1.0.4-1.1`, and numeric identifiers compare numerically (`1.0.3-44.9 < 1.0.3-44.10`).
- The Debian version `1.0.3.44-1` orders correctly under `dpkg --compare-versions` (`1.0.3.44-1 << 1.0.3.44-2 << 1.0.3.45-1 << 1.0.4.1-1`).
- The rpm `Version`/`Release` pair orders correctly under `rpmdev-vercmp`.
- `scripts/version.ts` CLI: `npm run version -- --print <field>` prints one field; `--json` prints the whole object; with no args prints a human table. It also writes `build/version.json`.

Unit tests (`tests/unit/versions.test.ts`) must:
1. Assert every field above for the example input and for `{version:"1.0.4", build:1, wrapper_revision:1}`.
2. Run real strings through **electron-updater's own comparator**: construct `new AppImageUpdater({ provider: "github", owner: "sams-git-195", repo: "qwenstudio-linux" }, fakeApp)` where `fakeApp` implements the `AppAdapter` interface with `version` = the current `appVersion`, `isPackaged = true`, and no-op methods; then assert `await updater.isUpdateAvailable({ version: candidate, files: [], path: "", sha512: "", releaseDate: "" })` is `true` for each newer candidate and `false` for equal/older candidates across the chain `1.0.3-44.1, 1.0.3-44.2, 1.0.3-44.10, 1.0.3-45.1, 1.0.4-1.1`. The devDependency is pinned to `electron-updater@6.6.2` (the bundled version).
3. Assert `updater.allowPrerelease === true` right after construction (documents why patch 2 sets it to `false`).
4. Assert `semver.valid("1.0.3-44.1")` is truthy and `semver.valid("1.0.3.44-1")` is `null` (documents why tags are not used for ordering).

## 8. Patches

Patches are real unified diffs against the unpacked `app.asar` tree, applied with `git apply` from `build/app/` as the working directory. `scripts/patch.ts` runs `git apply --check <patch>` for every patch first; any failure aborts the build with exit code 2 and the message `Patch <name> does not apply to upstream <appVersion>`. Only after all checks pass are patches applied in lexical order. Patch files are numbered `NNNN-<slug>.patch`.

### 8.1 `0001-linux-platform-dir.patch`

In `out/main/index.js`, function `getPlatformDir`, insert before the `throw`:

```js
  if (platform === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
```

### 8.2 `0002-linux-updater.patch`

All hunks are in `out/main/index.js`:

1. After the existing `require` block at the top of the file, add:
   ```js
   const linuxUpdate = require("./linux-update.js");
   ```
2. Inside `initializeAutoUpdater`, replace the feed selection so that on Linux the GitHub provider is used and prerelease-channel matching is disabled:
   ```js
   if (process.platform === "linux") {
     electronUpdater.autoUpdater.allowPrerelease = false;
     electronUpdater.autoUpdater.autoInstallOnAppQuit = !!process.env.APPIMAGE;
     electronUpdater.autoUpdater.setFeedURL({
       provider: "github",
       owner: "sams-git-195",
       repo: "qwenstudio-linux"
     });
   } else {
     electronUpdater.autoUpdater.setFeedURL({ provider: "generic", url: BASE_URL + platformSpecificPath });
   }
   ```
   The original `autoInstallOnAppQuit = true` assignment stays above (non-Linux behaviour unchanged).
3. In `checkForUpdates` (manual) and `autoUpdate` (startup), before the `electronUpdater.autoUpdater.checkForUpdates()` call, insert:
   ```js
   if (linuxUpdate.isNotifyOnly()) {
     linuxUpdate.check({ manual: true /* false in autoUpdate */, currentVersion: electron.app.getVersion(), dialog: electron.dialog, shell: electron.shell, net: electron.net, t: (k, o) => i18next.t(k, o), icon });
     return;
   }
   ```

### 8.3 `src/app/linux-update.js` (new file, copied to `out/main/linux-update.js`)

Plain CommonJS, no dependencies beyond `semver` (already in the asar's `node_modules`). Exports:

- `isNotifyOnly()` → `process.platform === "linux" && !process.env.APPIMAGE`.
- `parseLatestYaml(text)` → `{ version }` from a `latest-linux.yml` body (line-based parse of `^version:\s*(\S+)`; throws if absent).
- `compare(current, latest)` → `"newer" | "same" | "older"` using `semver.gt/eq`.
- `async check({ manual, currentVersion, dialog, shell, net, t, icon, fetchImpl })`:
  1. GET `https://github.com/sams-git-195/qwenstudio-linux/releases/latest/download/latest-linux.yml` using `fetchImpl ?? net.fetch`, 15 s timeout, no cache.
  2. Logs `[linux-update] update available <latest>` when newer, otherwise `[linux-update] up to date <current>` (these lines are asserted by QA step 8).
  3. If `compare === "newer"`: `dialog.showMessageBox({ type: "info", icon, title: t("update.new_version_found"), message: t("update.new_version_message", { version }), buttons: [t("update.download_now"), t("update.later")] })`; on response 0 → `shell.openExternal("https://github.com/sams-git-195/qwenstudio-linux/releases/latest")`.
  4. If not newer and `manual`: `dialog.showMessageBox({ type: "info", icon, message: t("update.latest_version", { version: currentVersion }) })`.
  5. On any error: `console.error("[linux-update]", err)`; if `manual`, show the same "latest version" box (mirrors upstream's error handler). Never throws.
- The module has no Electron import at top level so it is unit-testable with injected `dialog`, `shell`, `fetchImpl`.

Unit tests (`tests/unit/linux-update.test.ts`): `isNotifyOnly` under env permutations; `parseLatestYaml` on the fixture `tests/fixtures/latest-linux.yml`; `check()` shows the dialog and opens the URL when newer, shows "latest" only when manual, swallows fetch errors.

### 8.4 Patch maintenance

- `npm run patches:dev` runs stages 10.1–10.3 and stops, leaving `build/app-pristine/` (untouched upstream) and `build/app/` (patched) for editing.
- `npm run patches:export -- <NNNN>` (`scripts/patch.ts --export NNNN`) regenerates `patches/NNNN-<slug>.patch` deterministically: it creates a temporary git repository from a copy of `build/app-pristine/`, commits it, applies and commits every patch numbered lower than `NNNN`, copies the current `build/app/` tree over the working copy (excluding `package.json` and `out/main/linux-update.js`, which are produced by the patch stage, not by patches), and writes `git diff --src-prefix=a/ --dst-prefix=b/` to the patch file. The slug is taken from the existing file name; exporting a number with no existing file is an error.
- Maintainer procedure when upstream changes break a patch: `npm run patches:dev` (fails at `--check`), hand-edit `build/app/out/main/index.js` starting from the pristine file, then `npm run patches:export -- 0001` and `-- 0002`, then `npm run test:unit` (the `patch.test.ts` fixture must be refreshed from `build/app-pristine/out/main/index.js` in the same commit). `docs/ARCHITECTURE.md` documents this.

## 9. Update behaviour (runtime)

| Install type | Detection | Check | Download | Install |
|---|---|---|---|---|
| AppImage | `process.env.APPIMAGE` set | electron-updater GitHub provider, `allowPrerelease=false` | in-app (`downloadUpdate`, user-initiated via upstream dialog) | in-app `quitAndInstall` (upstream dialog) and on quit (`autoInstallOnAppQuit=true`) |
| deb / rpm | `APPIMAGE` unset | `linux-update.js` fetches `latest-linux.yml` | none; "Download now" opens the release page in the browser | package manager, by the user |

`resources/package-type` written by electron-builder into deb/rpm resources is harmless (the notify-only path never calls electron-updater) but **must not** be present in the AppImage (it would switch electron-updater to `DebUpdater`). Section 10.6 guarantees this.

## 10. Build pipeline

All scripts are TypeScript under `scripts/`, run with `tsx` on Node 22 LTS (`.nvmrc` = `22`). `npm run build` runs the stages in order; each stage is also runnable alone. Every stage is idempotent and skips work whose outputs are up to date only where stated.

### 10.1 `scripts/fetch.ts` — `npm run fetch`

- Reads `upstream.json` and `sidecars.json`.
- Downloads each URL into `.cache/<sha-prefix>/<basename>` where `<sha-prefix>` is the first 12 hex chars of the expected hash. Skips download if the file exists and its hash matches. Verifies SHA-512 (upstream) or SHA-256 (sidecars) after download; mismatch → delete file, exit 3 with `Checksum mismatch for <url>`.
- Retries 3 times with exponential backoff on network errors. Follows redirects.
- Output: `build/fetch.json` listing resolved local paths.

### 10.2 `scripts/extract.ts` — `npm run extract`

- Requires `7z`, `unzip` and `tar` on PATH (`p7zip-full unzip` on Debian/Ubuntu; `p7zip p7zip-plugins unzip` on Fedora). Zip archives are unpacked with `unzip` (preserves executable bits), the uv tarball with `tar`.
- `7z x <installer> -o build/nsis '$PLUGINSDIR/app-64.7z'` then `7z x build/nsis/$PLUGINSDIR/app-64.7z -o build/win-app`.
- Unpacks `build/win-app/resources/app.asar` to `build/app-pristine/` with `@electron/asar`, then copies to `build/app/` (working tree for patches).
- Extracts Electron zip to `build/electron/`, bun zip to `build/bun/`, uv tarball to `build/uv/`, validating each `extract` mapping exists.
- Reads `build/app-pristine/package.json`; asserts `name === "Qwen"` and that `version` equals `upstream.json.version` (mismatch → exit 4). Detects the Electron version by scanning `build/win-app/Qwen.exe` for the regex `Electron/(\d+\.\d+\.\d+)` and asserts it equals `sidecars.json.electron.version` (mismatch → exit 4 with both values printed).
- Copies `build/win-app/LICENSE.electron.txt` and `LICENSES.chromium.html` to `build/licenses/`.

### 10.3 `scripts/patch.ts` — `npm run patch`

- As specified in Section 8. Additionally copies `src/app/linux-update.js` to `build/app/out/main/linux-update.js` (copy happens before `git apply --check` so the patch never depends on it, but the smoke test requires it to load).
- Rewrites `build/app/package.json` `version` to `appVersion` (from `deriveVersions`), leaving all other fields untouched.
- Writes `build/patch.json` with the list of applied patches and their SHA-256.

### 10.4 `scripts/assemble.ts` — `npm run assemble`

Produces `build/linux-unpacked/`:

```
qwen-studio                  # build/electron/electron renamed; mode 0755
chrome-sandbox chrome_crashpad_handler libEGL.so libGLESv2.so libffmpeg.so
libvk_swiftshader.so libvulkan.so.1 vk_swiftshader_icd.json
icudtl.dat snapshot_blob.bin v8_context_snapshot.bin
resources.pak chrome_100_percent.pak chrome_200_percent.pak locales/
LICENSE LICENSES.chromium.html   # from the Electron zip
resources/
  app.asar                   # packed from build/app with @electron/asar (no unpack rules)
  assets/icon.png assets/icon_dark.png
  i18n/*.json                # all 12 files
  bun/bun                    # mode 0755
  python/uv python/uvx       # mode 0755
```

Rules:
- `resources/default_app.asar` from the Electron zip is deleted.
- `elevate.exe`, `app-update.yml`, `bun.exe`, `uv.exe`, `uvx.exe` are not copied.
- `build/linux-unpacked/` is deleted and recreated on every run.
- Post-conditions asserted by the script: `qwen-studio` is executable; `resources/app.asar` lists `out/main/linux-update.js` and its `package.json` version equals `appVersion`; `resources/bun/bun --version` prints `1.2.10`; `resources/python/uvx --version` prints `uvx 0.12.15`.

### 10.5 `scripts/icons.ts` — `npm run icons`

Uses `sharp` to render `build/win-app/resources/assets/icon.png` to `build/icons/<N>x<N>.png` for N in 16, 24, 32, 48, 64, 128, 256, 512 (electron-builder consumes a directory of `NxN.png` files as `linux.icon`). Aspect ratio is preserved (source is square; script asserts width === height).

### 10.6 `scripts/build.ts` — `npm run build`

Runs 10.1 → 10.2 → 10.3 → 10.4 → 10.5, then for each target in `["AppImage", "deb", "rpm"]`:

1. Remove `build/stage-<target>/` if present and copy `build/linux-unpacked/` to it with Node's `fs.cpSync(src, dst, { recursive: true })` preserving file modes (separate staging copy so electron-builder's per-target writes into `resources/` — `package-type`, `app-update.yml`, `apparmor-profile` — never leak between targets).
2. Generate `build/electron-builder.<target>.json` = `packaging/electron-builder.base.json` deep-merged with the dynamic fields from `scripts/lib/electron-builder-config.ts` (Section 10.7).
3. Run `npx electron-builder --linux <target> --x64 --config build/electron-builder.<target>.json --prepackaged build/stage-<target> --publish never` with `directories.output = dist/<target-lowercase>`.
4. Move the resulting package into `dist/` (flat). For AppImage also move `dist/appimage/latest-linux.yml` to `dist/latest-linux.yml`. The `latest-linux.yml` files produced by the deb/rpm invocations are discarded.

`electron-builder` is pinned to `26.15.3` in `devDependencies`. Building the rpm target on Debian/Ubuntu requires the `rpm` package (`apt-get install -y rpm`); building deb/rpm requires nothing else because electron-builder downloads its own `fpm`.

Environment: `ELECTRON_BUILDER_CACHE` defaults to `.cache/electron-builder` (checked-in `.npmrc` is not used; the build script sets the env var if unset) so CI caching covers fpm/AppImage tooling.

### 10.7 electron-builder configuration

`packaging/electron-builder.base.json` (static):

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
    "depends": ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "libasound2", "libdrm2", "libgbm1", "libxkbcommon0", "libatk-bridge2.0-0", "libatk1.0-0", "libcups2", "libdbus-1-3", "libexpat1", "libx11-6", "libxcomposite1", "libxdamage1", "libxext6", "libxfixes3", "libxrandr6", "libpango-1.0-0", "libcairo2", "libglib2.0-0", "libnspr4", "libc6"],
    "recommends": ["libappindicator3-1"]
  },
  "rpm": {
    "depends": ["gtk3", "libnotify", "nss", "libXScrnSaver", "libXtst", "xdg-utils", "at-spi2-core", "libuuid", "libsecret", "alsa-lib", "libdrm", "mesa-libgbm", "libxkbcommon", "at-spi2-atk", "atk", "cups-libs", "dbus-libs", "expat", "libX11", "libXcomposite", "libXdamage", "libXext", "libXfixes", "libXrandr", "pango", "cairo", "glib2", "nspr"]
  },
  "appImage": {}
}
```

Dynamic fields added by `scripts/lib/electron-builder-config.ts` from `deriveVersions()` and the target name:
- `extraMetadata.version = appVersion`, `extraMetadata.name = "qwen-studio"`, `extraMetadata.description` and `extraMetadata.homepage = "https://github.com/sams-git-195/qwenstudio-linux"`.
- `linux.target = [<target>]`; `directories.output = "dist/<target-lowercase>"`.
- `deb.artifactName = artifacts.deb`, `deb.fpm = ["--version", upstreamLabel, "--iteration", String(wrapper_revision)]` (for the example: `--version 1.0.3.44 --iteration 1`, giving deb `Version: 1.0.3.44-1`). Rationale: electron-builder passes `--version 1.0.3~44.1` itself; fpm's option parser takes the last occurrence, and the extra args are appended after electron-builder's. `scripts/verify.ts` asserts the resulting `Version` field; if the assertion ever fails, the build fails (no silent fallback).
- `rpm.artifactName = artifacts.rpm`, `rpm.fpm = ["--version", rpmVersion, "--iteration", rpmRelease]` (identical values to the deb case).
- `appImage.artifactName = artifacts.appImage`.

The deb/rpm dependency lists **replace** electron-builder defaults; they therefore include the defaults plus the libraries reported by `ldd` on the Electron 35.1.4 binary. A unit-level check (`tests/unit/deps.test.ts`, runs only when `build/linux-unpacked/qwen-studio` exists, otherwise skipped with a message) runs `ldd` on `qwen-studio`, maps each `.so` to its Debian package via a static table in `tests/fixtures/soname-to-deb.json`, and asserts every mapped package is in `deb.depends`. `libappindicator3-1` is only recommended because the app does not create a tray icon (verified: no `Tray` usage in `out/main/index.js`).

Launcher semantics: electron-builder's stock `after-install` script installs `/usr/bin/qwen-studio` (via `update-alternatives`, falling back to a symlink) pointing at `/opt/Qwen Studio/qwen-studio`, sets `chrome-sandbox` to mode 4755 when user namespaces are unavailable and 0755 otherwise, and installs the AppArmor profile on Ubuntu 24.04+. This stock script is used unmodified. The `--ozone-platform-hint=auto` flag is delivered through `linux.executableArgs`, which electron-builder places in the `.desktop` `Exec=` line for all three targets. Launching from a terminal via `/usr/bin/qwen-studio` runs without the flag (X11/XWayland fallback), which is acceptable and documented in the README. `--no-sandbox` is never shipped in any launcher, desktop file or wrapper.

### 10.8 `scripts/verify.ts` — `npm run verify`

Asserts, without installing anything:
- `dist/` contains exactly the three artifact names from `deriveVersions()` plus `latest-linux.yml`.
- `dpkg-deb -f <deb> Version` equals `debVersion`; `dpkg-deb -f <deb> Package` equals `qwen-studio`; `dpkg-deb -c <deb>` lists `./opt/Qwen Studio/qwen-studio`, `./opt/Qwen Studio/resources/bun/bun`, `./opt/Qwen Studio/resources/python/uvx`, `./usr/share/applications/qwen-studio.desktop`, `./usr/share/icons/hicolor/512x512/apps/qwen-studio.png`.
- `rpm -qp --qf '%{NAME} %{VERSION} %{RELEASE}'` equals `qwen-studio 1.0.3.44 1` (values from `deriveVersions`); `rpm -qpl` lists the same paths as above.
- The AppImage is executable; `--appimage-extract` into `build/appimage-extracted/` succeeds; `squashfs-root/resources/package-type` does **not** exist; `squashfs-root/qwen-studio.desktop` contains `Exec=AppRun --ozone-platform-hint=auto %U`, `Categories=Network;Chat;`, `MimeType=x-scheme-handler/qwen;`.
- The extracted deb/rpm desktop file (`dpkg-deb -x` / `rpm2cpio | cpio`) contains `Exec="/opt/Qwen Studio/qwen-studio" --ozone-platform-hint=auto %U` and `MimeType=x-scheme-handler/qwen;`. `desktop-file-validate` passes on all three desktop files.
- `latest-linux.yml` `version` equals `appVersion`, `path` and `files[0].url` equal `artifacts.appImage`, `sha512` equals the AppImage's actual base64 SHA-512, `size` equals its byte size.
- The `app.asar` inside the deb payload has `package.json` version equal to `appVersion` (guards the `--prepackaged` + `extraMetadata` mismatch).

## 11. Testing

### 11.1 Unit tests (vitest)

`npm run test:unit` = `vitest run`. Files under `tests/unit/`:
- `versions.test.ts` (Section 7).
- `manifest.test.ts`: valid manifests pass; missing field, bad base64, `/latest/` URL, non-`download.qwen.ai` URL all throw with the expected message.
- `feed.test.ts`: `parseFeed(text)` from `scripts/lib/manifest.ts` parses the fixture `tests/fixtures/latest.yml` (a verbatim copy of Section 3.1) into `{version:"1.0.3", build:44, url, sha512, size, releaseDate}`; rejects a filename that does not match the regex; rejects a mismatched `version` vs filename.
- `linux-update.test.ts` (Section 8.3).
- `electron-builder-config.test.ts`: the generated config for each target contains the expected `artifactName`, `fpm` args, `extraMetadata.version`, `directories.output`.
- `patch.test.ts`: `git apply --check` of every file in `patches/` succeeds against `tests/fixtures/app-pristine/out/main/index.js` — a committed verbatim copy of the upstream `out/main/index.js` for the version in `upstream.json` (22.7 KB; refreshed by the bot on each bump, Section 12.3). This makes patch drift visible in unit tests without downloading 125 MB.
- `deps.test.ts` (Section 10.7; skipped when no build output).
- `changelog.test.ts`: `renderEntry()` output for a sample release.

Coverage threshold: none enforced (the scripts are thin). Typecheck: `npm run typecheck` = `tsc --noEmit`.

### 11.2 Full build in CI

Runner `ubuntu-22.04`. Steps: `apt-get install -y p7zip-full unzip rpm lintian rpmlint desktop-file-utils libfuse2 xvfb xauth cpio pipx`; `actions/setup-node@v4` with `.nvmrc`; `npm ci`; restore `.cache/` via `actions/cache` keyed on `hashFiles('upstream.json','sidecars.json')`; `npm run build`; `npm run verify`; upload `dist/` as artifact `packages`.

### 11.3 Package linters

- `lintian --suppress-tags-from-file packaging/lintian/qwen-studio.overrides --fail-on error <deb>`. Pass criterion: exit code 0 (warnings are printed, never fatal). The overrides file lists one tag per line, each preceded by a `#` comment line giving the justification. Decision rule for adding a tag: an `E:` tag may be suppressed **only** if it is caused by files shipped verbatim from the Electron runtime or the upstream app (for example `embedded-library`, `unstripped-binary-or-object`, `dir-or-file-in-opt`, `binary-or-shlib-defines-rpath`, `shared-library-lacks-prerequisites`); `E:` tags about the desktop file, control fields, dependencies, maintainer scripts, or file permissions must be fixed in packaging, never suppressed. The initial file is produced by the plan task that first runs lintian on a real build and applies this rule.
- `rpmlint -c packaging/rpmlint/qwen-studio.toml <rpm>`. Pass criterion: the summary line reports `0 errors`; warnings allowed. The config's `Filters` list follows the same decision rule as the lintian overrides (only findings inherent to the verbatim Electron/upstream payload, each with a comment), and is produced by the same plan task.
- AppImage: `appimagelint` (https://github.com/TheAssassin/appimagelint, installed with `pipx install git+https://github.com/TheAssassin/appimagelint@<pinned commit>`) runs in **advisory** mode: its output is uploaded as artifact `appimagelint-report` and never fails the job (Electron AppImages are expected to fail its glibc/glibcxx compatibility heuristics). Blocking AppImage checks are those in Section 10.8.

### 11.4 Install matrix (Docker on the ubuntu-22.04 runner)

Job matrix (each leg is one job, downloads the `packages` artifact, mounts `dist/` and `tests/` read-only, and runs `bash /tests/install/install-and-smoke.sh <format>` inside the container):

| Leg | Image | Format | Install command |
|---|---|---|---|
| deb-ubuntu-22.04 | `ubuntu:22.04` | deb | `apt-get update && apt-get install -y ./qwen-studio_*.deb` |
| deb-ubuntu-24.04 | `ubuntu:24.04` | deb | same |
| deb-debian-12 | `debian:12` | deb | same |
| rpm-fedora-40 | `fedora:40` | rpm | `dnf install -y ./qwen-studio-*.rpm` |
| rpm-fedora-41 | `fedora:41` | rpm | same |
| appimage-ubuntu-22.04 | `ubuntu:22.04` | appimage | `./qwen-studio-*.AppImage --appimage-extract` (no fuse needed) |
| appimage-fedora-41 | `fedora:41` | appimage | same |

`install-and-smoke.sh` additionally installs the test-only tooling (`xvfb`/`xorg-x11-server-Xvfb`, `curl`, `ca-certificates`, `procps`, plus for AppImage legs the same runtime libraries the deb/rpm declares, installed by package name list embedded in the script) and then:
- deb/rpm: asserts `/usr/bin/qwen-studio` resolves to `/opt/Qwen Studio/qwen-studio`; asserts `/opt/Qwen Studio/chrome-sandbox` is owned by root and its mode is `4755` or `0755`; asserts `/usr/share/applications/qwen-studio.desktop` exists and `desktop-file-validate` passes; asserts `xdg-mime query default x-scheme-handler/qwen` prints `qwen-studio.desktop` after `update-desktop-database`; then runs `tests/smoke/smoke.sh "/opt/Qwen Studio/qwen-studio" "/opt/Qwen Studio/resources"`.
- appimage: runs `tests/smoke/smoke.sh squashfs-root/qwen-studio squashfs-root/resources` (this path has `APPIMAGE` unset and therefore exercises the notify-only updater path; no AppImage-runtime in-app update test is performed in CI).
- deb legs additionally run `apt-get remove -y qwen-studio` and assert `/opt/Qwen Studio` is gone; rpm legs run `dnf remove -y qwen-studio` and assert the same.

Docker containers are started with `--shm-size=1g` and default seccomp; no `--privileged`. Ubuntu 24.04's `t64` library renames (`libasound2t64` etc.) are handled by apt's `Provides`, and the 24.04 leg exists to prove it.

### 11.5 Smoke test (`tests/smoke/smoke.sh <executable> <resources-dir>`)

Environment: fresh `HOME=$(mktemp -d)`, `XDG_CONFIG_HOME` unset, `ELECTRON_ENABLE_LOGGING=1`, `DISPLAY` provided by `xvfb-run -a`. Steps and pass criteria:

1. `"$RES/bun/bun" --version` prints exactly `1.2.10`; `"$RES/python/uvx" --version` starts with `uvx 0.12.15`; `"$RES/python/uv" --version` starts with `uv 0.12.15`.
2. Launch: `xvfb-run -a "$EXE" --remote-debugging-port=9333 --no-sandbox > smoke.log 2>&1 &`. `--no-sandbox` is a **test-only** flag required because Docker's default seccomp profile blocks user namespaces and the extracted AppImage's `chrome-sandbox` is not setuid; it is never part of any shipped launcher (Section 10.7).
3. Poll `http://127.0.0.1:9333/json` every 1 s for up to 60 s until the JSON contains a target with `"type":"page"` whose `url` ends with `/out/renderer/index.html`. Timeout → fail.
4. Poll for up to a further 30 s until a target with `"type":"webview"` exists whose `url` starts with `https://chat.qwen.ai`. Timeout → fail. (CI runners have outbound network; the check verifies the `<webview>` was created and navigated, not that the site rendered.)
5. `grep -E "Unsupported platform|Cannot find module|ERR_UPDATER_INVALID_VERSION" smoke.log` must find nothing. Note: `[linux-update]` errors are allowed (GitHub may return 404 before the first release; the module swallows them).
6. Clean exit (skipped when `SMOKE_KEEP_RUNNING=1`, in which case the script prints `SMOKE_PID=<pid>` and `SMOKE_HOME=<the temporary HOME>` and exits 0 leaving the app running for the caller): for every `page` target id, `curl -s -X PUT "http://127.0.0.1:9333/json/close/<id>"`. Wait up to 30 s for the process to exit; its exit code must be `0`. If it has not exited after 30 s, `kill -TERM` and fail.
7. Print `smoke.log` on failure; always upload it as a job artifact.

### 11.6 Security and hygiene

- `npm audit --audit-level=high` in CI (fails on high/critical in the wrapper's own dependency tree).
- CodeQL (`codeql.yml`): language `javascript-typescript`, on `push` to main, `pull_request`, weekly schedule.
- Dependabot (`.github/dependabot.yml`): `npm` weekly, `github-actions` weekly; Dependabot PRs are labelled `dependencies` and are **not** auto-merged.
- `commitlint` (`@commitlint/config-conventional`) runs on PR commits via `wagoid/commitlint-github-action`. Squash-merge is the only merge method; the PR title must follow Conventional Commits (validated by `amannn/action-semantic-pull-request`).

## 12. CI workflows

### 12.1 `build-and-test.yml` (reusable, `workflow_call`)

Inputs: none. Jobs: `build` (Section 11.2 + 11.3 + 10.8) → `install-matrix` (Section 11.4, `needs: build`). Outputs: the `packages` artifact (retention 7 days). Used by both `ci.yml` and `release.yml` so the release re-runs the identical matrix on the exact artifacts it publishes.

### 12.2 `ci.yml`

Triggers: `pull_request` (all branches), `push` to `main`, `workflow_dispatch`.
Permissions: `contents: read`, `pull-requests: write` (for the `needs-human` labeller).

Jobs:
1. `changes` — computes `build_needed`: `true` on push/dispatch; on PRs, `true` unless every changed file matches `docs/**`, `**/*.md`, `.github/ISSUE_TEMPLATE/**`, `LICENSE`, `CODEOWNERS`.
2. `lint-unit` — always: `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm audit --audit-level=high`, commitlint, semantic PR title.
3. `build-and-test` — `needs: changes`, `if: needs.changes.outputs.build_needed == 'true'`, `uses: ./.github/workflows/build-and-test.yml`.
4. `ci-status` — `needs: [changes, lint-unit, build-and-test]`, `if: always()`. Fails if `lint-unit` is not `success`, or if `build-and-test` is neither `success` nor (`skipped` while `build_needed == 'false'`). This is the **only** required status check (Section 13).
5. `flag-needs-human` — `needs: [ci-status]`, `if: failure() && github.event_name == 'pull_request' && startsWith(github.head_ref, 'upstream/')`: adds label `needs-human`, removes label `automerge`, posts a comment `Automated upstream bump failed CI. See <run url>. A maintainer must fix the branch or close this PR.` (idempotent: only one such comment per run id).

### 12.3 `upstream-check.yml` (the bot)

Triggers: `schedule: cron "17 4 * * *"` (daily 04:17 UTC), `workflow_dispatch` with inputs `feed_url` (string, default `https://download.qwen.ai/windows/x64/latest.yml`), `base_branch` (string, default `main`), `dry_run` (boolean, default `false`).
Permissions: `contents: write`, `pull-requests: write`, `issues: write` (step 9 opens issues). Uses secret `UPSTREAM_BOT_TOKEN` (a fine-grained PAT of the repository owner with `Contents: Read and write`, `Pull requests: Read and write`, `Workflows: Read and write` on this repository). Rationale: PRs and pushes made with the default `GITHUB_TOKEN` do not trigger `ci.yml`, so auto-merge would never see a green check.

Steps (`scripts/upstream-check.ts`, all logic unit-tested via injected fetch/exec):
1. Checkout `base_branch` with `UPSTREAM_BOT_TOKEN`.
2. Fetch `feed_url`; parse with `parseFeed` (Section 11.1). Resolve the installer URL as `new URL(files[0].url, feed_url)`.
3. Compare the tuple `(semver version, build)` with `upstream.json` (semver compare first, then integer build). If the feed is equal or older: log `Up to date` and exit 0.
4. Download the installer (Section 10.1 logic), verify `sha512`, extract (Section 10.2 logic) and run: (a) `git apply --check` for all patches against the new `out/main/index.js`; (b) Electron version detection; (c) `package.json` version check. Record results.
5. Write the new `upstream.json` (`wrapper_revision: 1`, `size` = actual bytes) and replace `tests/fixtures/app-pristine/out/main/index.js` with the new upstream file. Prepend a `CHANGELOG.md` "Unreleased" entry `Upstream bump to <version>.<build> (released <releaseDate>)`.
6. Branch name: `upstream/<base_branch>/v<version>.<build>`. If the branch already exists remotely, force-push to it (do not open a second PR). If an open PR from that branch exists, reuse it (update title/body). If `dry_run`, print the diff and stop here.
7. Commit `chore(upstream): bump Qwen Studio to <version>.<build>` (author `qwenstudio-linux-bot <noreply@github.com>`), push, create/update the PR against `base_branch` with title identical to the commit subject, body listing feed data, the check results from step 4, and the literal line `CI: pending` (the `flag-needs-human` job appends the run URL on failure). Labels: `upstream-bump`.
8. If all step-4 checks passed: add label `automerge` and run `gh pr merge --auto --squash <pr>`. If any check failed: add label `needs-human`, do not enable auto-merge, and post a comment with the failing check output (patch rejects, Electron version delta, etc.).
9. Any unexpected error (network, regex mismatch on filename) → open (or update) a single issue titled `Upstream bot failure: <short reason>` using the `upstream_bump` issue template fields, label `needs-human`, exit 1.

The bot never modifies `sidecars.json`. An Electron version change is reported in the PR and via `needs-human`; a maintainer then updates `sidecars.json` on the bot's branch.

### 12.4 `release.yml`

Triggers: `push` to `main`, `workflow_dispatch`.
Permissions: `contents: write`, `id-token: write`, `attestations: write`, `pull-requests: write`.

Jobs:
1. `plan` — `npm ci`; `TAG=$(npm run -s version -- --print gitTag)`; `git ls-remote --exit-code --tags origin "refs/tags/$TAG"`; outputs `tag`, `skip=true` if the tag exists. **Rule:** if the tag exists the workflow ends successfully with the annotation `Tag <tag> already exists; nothing to release`. A tag that exists with a missing or partial GitHub Release is a manual-recovery situation documented in `docs/RELEASING.md` (delete the release and the tag, then re-run via `workflow_dispatch`); the workflow never resumes a partial release.
2. `build-and-test` — `if: needs.plan.outputs.skip != 'true'`, `uses: ./.github/workflows/build-and-test.yml` (full matrix on the exact artifacts to be published).
3. `publish` — `needs: [plan, build-and-test]`: download `packages`; `sha256sum *.deb *.rpm *.AppImage latest-linux.yml > SHA256SUMS`; `actions/attest-build-provenance@v2` with `subject-path: dist/*.deb, dist/*.rpm, dist/*.AppImage`; generate notes with `scripts/changelog.ts --release-notes` (header: upstream version/build/releaseDate, wrapper revision, Electron/bun/uv versions, install instructions, the non-affiliation notice, SHA256 list) followed by GitHub's auto-generated notes (`--generate-notes`); `gh release create "$TAG" --title "<releaseName>" --notes-file notes.md --latest dist/*.deb dist/*.rpm dist/*.AppImage dist/latest-linux.yml dist/SHA256SUMS`. The release is **not** a prerelease and **not** a draft (electron-updater's GitHub provider requires this, Section 3.4). Asset upload order: `latest-linux.yml` is uploaded **last** so a client never sees the YAML before the AppImage exists.
4. `changelog` — `needs: publish`: `scripts/changelog.ts --finalize <tag>` moves the "Unreleased" section into a `## [<tag>] - <date>` section; opens a PR `chore(release): changelog for <tag>` from branch `release/changelog-<tag>` using `UPSTREAM_BOT_TOKEN`, label `automerge`, `gh pr merge --auto --squash`. Because this PR is docs-only, `ci.yml` runs only `lint-unit` and `ci-status`; when it merges, `release.yml` runs again, finds the tag, and skips.

### 12.5 Auto-merge and required checks

Auto-merge requires (a) repository setting "Allow auto-merge" enabled, (b) "Allow squash merging" as the only enabled merge method, and (c) a branch ruleset that requires the `ci-status` check. Without (c) GitHub refuses to enable auto-merge. These are repository settings, not YAML, and are documented in `docs/BRANCH_PROTECTION.md`.

## 13. Branch protection (documented in `docs/BRANCH_PROTECTION.md`)

Ruleset `protect-main-and-qa`, target branches `main` and `qa/**`:
- Require a pull request before merging; 0 required approvals (the bot must merge without a human); dismiss stale approvals: off.
- Require status checks to pass: `ci-status` (strict: branch must be up to date — **off**, to avoid the bot needing to rebase on every docs merge).
- Require conversation resolution: off.
- Block force pushes; restrict deletions.
- Bypass list: empty.
- Repository settings: "Allow auto-merge" on; "Automatically delete head branches" on; squash merge only; default commit message = PR title and description.
- Secrets: `UPSTREAM_BOT_TOKEN` (Section 12.3). Actions permissions: "Allow GitHub Actions to create and approve pull requests" on.

The `qa/**` target exists so workstream F can exercise the bot end-to-end against a branch other than `main` (Section 16).

## 14. Governance and documentation

| File | Required content |
|---|---|
| `README.md` | What it is; **non-affiliation notice** ("not affiliated with, endorsed by or supported by Alibaba Cloud / Qwen; 'Qwen' is a trademark of its owner"); install instructions per format (deb: `sudo apt install ./file.deb`; rpm: `sudo dnf install ./file.rpm`; AppImage: `chmod +x`, requires `libfuse2` on Ubuntu 22.04+/Debian, or use `--appimage-extract`); update behaviour per format (Section 9); Wayland note (`--ozone-platform-hint=auto` in the desktop entry); **telemetry disclosure** (the upstream app bundles `@ali/aes-tracker` and reports usage events to Alibaba; this project does not add or remove telemetry); **upstream license pointer** (the app is proprietary; use is governed by Alibaba's Qwen terms, link to https://chat.qwen.ai/ terms; only the packaging scripts are MIT); how upstream tracking works; badges (CI, release, license); link to SECURITY.md and CONTRIBUTING.md. |
| `LICENSE` | MIT, copyright 2026 sams-git-195, applies to repository contents only. |
| `THIRD_PARTY_NOTICES.md` | Table: Qwen Studio (proprietary, Alibaba; redistributed unmodified except patches in `patches/`), Electron 35.1.4 (MIT, LICENSE.electron.txt shipped), Chromium (LICENSES.chromium.html shipped), bun 1.2.10 (MIT), uv 0.12.15 (MIT/Apache-2.0), electron-builder (MIT), plus a pointer to `npm ls --prod` for wrapper deps. |
| `CONTRIBUTING.md` | Dev setup (Fedora/Ubuntu package lists, Node 22 via nvm, `npm ci`, `npm run build`), running unit/smoke tests locally, patch maintenance (Section 8.4), Conventional Commits, PR process, DCO-free. |
| `SECURITY.md` | Two channels: vulnerabilities in the **wrapper/packaging** → GitHub private vulnerability reporting on this repo; vulnerabilities in the **upstream app or chat.qwen.ai** → Alibaba's security contact (link), not this repo. Supported versions: latest release only. |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 with contact `samheard95@gmail.com`. |
| `CHANGELOG.md` | Keep-a-Changelog format; `## [Unreleased]` section maintained by the bot and humans; finalized by `release.yml`. |
| `docs/ARCHITECTURE.md` | Pipeline diagram (stages 10.1–10.8), directory layout, patch strategy, updater design (Section 9 incl. the verified electron-updater facts), version scheme table (Section 7). |
| `docs/RELEASING.md` | Normal flow (automatic), manual re-run, partial-release recovery, bumping `wrapper_revision`, updating `sidecars.json`, rotating `UPSTREAM_BOT_TOKEN`. |
| `docs/BRANCH_PROTECTION.md` | Section 13 verbatim as a checklist with screenshots-free step list. |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Fields: package format, distro/version, Wayland/X11, app version (from About), steps, `smoke.log`-style output; checkbox "I understand this is unofficial packaging". |
| `.github/ISSUE_TEMPLATE/upstream_bump.yml` | Fields: upstream version/build, feed URL, what failed (patch/electron/other), logs. Used by humans and by the bot (Section 12.3 step 9). |
| `.github/ISSUE_TEMPLATE/packaging.yml` | Fields: format, distro, dependency/desktop/icon problem, output of `dpkg -s`/`rpm -qi`. |
| `.github/ISSUE_TEMPLATE/config.yml` | `blank_issues_enabled: false`; link "Problems with Qwen Chat itself → chat.qwen.ai support". |
| `.github/PULL_REQUEST_TEMPLATE.md` | Checklist: conventional title, tests added/updated, docs updated, `npm run build` passes locally (or CI). |
| `.github/CODEOWNERS` | `* @sams-git-195` |
| `commitlint.config.cjs` | `extends: ["@commitlint/config-conventional"]`, allowed scopes unrestricted. |

## 15. Workstreams and dependencies (for the implementation plan)

- **A — Pipeline scripts** (manifests, version function, fetch/extract/patch/assemble/icons/build/verify, patches, `linux-update.js`, unit tests). No dependencies.
- **B — Packaging** (electron-builder config, desktop/icons, dependency lists, linters config, `verify.ts` package assertions). Depends on A's assemble output.
- **C — CI test matrix** (`build-and-test.yml`, `ci.yml`, smoke and install scripts, CodeQL, Dependabot, commitlint). Depends on A and B.
- **D — Release + upstream bot** (`release.yml`, `upstream-check.yml`, `upstream-check.ts`, `changelog.ts`, branch-protection docs). Depends on C.
- **E — Governance docs**. Independent; runs in parallel with A–D.
- **F — Final QA**. Serial, last (Section 16).

## 16. Workstream F — Final QA procedure (executed by a Fable 5.1 medium-effort review agent)

Preconditions: A–E merged to `main`; repository settings from Section 13 applied by the owner; `UPSTREAM_BOT_TOKEN` configured; at least one release published by `release.yml`.

The agent must run every step below, record the exact command and outcome in a QA report issue titled `QA: final review <date>`, file one issue per defect (label `qa-defect`), and repeat the failing steps after fixes until all pass.

1. Clean clone: `git clone https://github.com/sams-git-195/qwenstudio-linux.git /tmp/qa && cd /tmp/qa && git status --short` must be empty; `git ls-files | grep -E '\.exe$'` must be empty.
2. `nvm use && npm ci && npm run typecheck && npm run test:unit` — all pass.
3. `npm run build && npm run verify` — passes; `ls dist/` shows exactly the four expected files.
4. Linters: `lintian --suppress-tags-from-file packaging/lintian/qwen-studio.overrides --fail-on error dist/*.deb` and `rpmlint -c packaging/rpmlint/qwen-studio.toml dist/*.rpm` — pass.
5. Fresh containers, one per row of the Section 11.4 table: `docker run --rm --shm-size=1g -v "$PWD/dist:/dist:ro" -v "$PWD/tests:/tests:ro" <image> bash /tests/install/install-and-smoke.sh <format>` — all seven pass.
6. Compare the locally built artifacts with the latest GitHub Release: `gh release download <tag> -D /tmp/rel` then `sha256sum -c /tmp/rel/SHA256SUMS` inside `/tmp/rel` passes; `gh attestation verify /tmp/rel/*.AppImage --owner sams-git-195` passes (and likewise for the deb and rpm).
7. Updater path (AppImage, real runtime): on a host with fuse (so the AppImage runtime sets `APPIMAGE`), run the **previous** release's AppImage if one exists, otherwise a locally built AppImage whose `upstream.json` `wrapper_revision` was temporarily set to `0` (never committed), with `ELECTRON_ENABLE_LOGGING=1`. The app checks for updates automatically at startup (`autoUpdate()`); assert the log contains `Checking for updates...` followed by `Update available:` mentioning the released `appVersion`, and does not contain `ERR_UPDATER_NO_PUBLISHED_VERSIONS` or `ERR_UPDATER_INVALID_VERSION`. Close the app without downloading.
8. Updater path (deb): install the deb in an `ubuntu:24.04` container built from a locally built package with `wrapper_revision` temporarily `0`, run the smoke harness with `SMOKE_KEEP_RUNNING=1`, and assert `smoke.log` contains `[linux-update] update available <version>` (the module logs this line before showing the dialog) and does **not** contain `pkexec`.
9. Upstream-bump simulation: create branch `qa/bump-sim` from `main`; on it set `upstream.json` `build` to `43` and `url` to the same URL with `.43.` (this state is intentionally unbuildable and is never built); push. Run `gh workflow run upstream-check.yml -f base_branch=qa/bump-sim`. Expected: a PR from `upstream/qa/bump-sim/v1.0.3.44` targeting `qa/bump-sim`, labelled `upstream-bump` and `automerge`, with `upstream.json` restored to build 44 and `wrapper_revision: 1`, auto-merge enabled, CI green (full build + matrix), PR auto-merged. Then delete `qa/bump-sim` and confirm no release was created (release.yml only triggers on `main`).
10. Bot failure path: run `gh workflow run upstream-check.yml -f base_branch=qa/bump-sim -f feed_url=<raw URL of tests/fixtures/latest-bad-filename.yml on main>` (a fixture whose `files[0].url` does not match the filename regex). Expected: an issue `Upstream bot failure: ...` labelled `needs-human`, exit 1, no PR.
11. Docs-only merge: open and merge a PR touching only `README.md`. Expected: `ci.yml` runs `lint-unit` + `ci-status` only (`build-and-test` skipped), `release.yml` runs and skips with `Tag ... already exists`.
12. Public-repo checklist review of every file in Section 14 (non-affiliation, telemetry, license pointer present; SECURITY.md has both channels; issue templates render; CODEOWNERS valid; Dependabot and CodeQL enabled and green; `Allow auto-merge` on; ruleset present with `ci-status` required; secret present).
13. Deep link: inside an `ubuntu:24.04` container with the deb installed, start the app with `SMOKE_KEEP_RUNNING=1 tests/smoke/smoke.sh ...`, then run `HOME=$SMOKE_HOME "/opt/Qwen Studio/qwen-studio" --no-sandbox 'qwen://open?token=test'` (a second instance; upstream holds `requestSingleInstanceLock`, so the first instance receives `second-instance`); `smoke.log` must contain `second-instance` and `qwen://open?token=test`. Also assert `xdg-mime query default x-scheme-handler/qwen` prints `qwen-studio.desktop`.

Exit criterion: all 13 steps pass on the same commit of `main`; the QA report issue is closed with the commit SHA.

## 17. Deviations from earlier decisions (and why)

1. **Patch 2 mechanism.** The earlier decision text said: on Linux use the GitHub provider and set `autoInstallOnAppQuit=false` when not running as AppImage. Verification (Section 3.4) showed that (a) with a prerelease-style version `allowPrerelease` defaults to `true`, which breaks release selection against our tags, so `allowPrerelease=false` is added; and (b) on non-AppImage installs electron-updater either does nothing (`APPIMAGE` unset → `AppImageUpdater` inactive) or, when electron-builder's `package-type` file is present, runs `pkexec`-based installs. Neither gives "notify only". Therefore deb/rpm notification is implemented by the small `linux-update.js` module. The intent (AppImage full in-app update, deb/rpm notify-only, no pkexec) is preserved.
2. **Launcher.** Instead of shipping a custom `/usr/bin/qwen-studio` wrapper script, the stock electron-builder post-install (symlink, sandbox chmod, AppArmor) is kept and `--ozone-platform-hint=auto` is delivered via `linux.executableArgs` in the desktop entry, avoiding a hand-maintained copy of electron-builder's install script.
3. **Feed `size`.** Not enforced because the upstream feed's value is wrong for the current release.
4. **Separate electron-builder invocations per target.** Required to keep `package-type` out of the AppImage.

## 18. Risks

- Upstream CDN removes old installers → old tags unbuildable (accepted).
- Upstream changes `out/main/index.js` structure → patches fail; the bot flags `needs-human`; patch refresh is manual.
- Upstream bumps Electron → `sidecars.json` manual update; `needs-human`.
- The `t64` transition on Ubuntu 24.04 relies on `Provides` for the old names; proven by the 24.04 matrix leg.
- Fedora 40/41 images are past end-of-life at the time of writing; `dnf` still resolves against archived mirrors. If a leg starts failing for mirror reasons, the matrix is updated to the current Fedora releases (a packaging PR, not a spec change).
- GitHub may retire the `ubuntu-22.04` hosted runner; the build does not depend on the runner's glibc (the Electron binary is prebuilt), so moving to `ubuntu-24.04` is a one-line change.
- `fpm --version/--iteration` override relies on last-occurrence-wins; `verify.ts` catches any regression immediately.
- `appimagelint` is advisory only.
- The `/releases/latest` redirect used by both updater paths depends on the release being marked latest; `release.yml` passes `--latest`.
