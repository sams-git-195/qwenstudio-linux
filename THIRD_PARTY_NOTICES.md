# Third-party notices

The release artifacts redistribute the following components. The MIT license in `LICENSE` covers only this repository's own files (packaging scripts, patches, CI configuration, documentation).

| Component | Version | License | Notes |
| --- | --- | --- | --- |
| Qwen Studio (application, `app.asar`, `resources/i18n`, `resources/assets`) | pinned in `upstream.json` (currently 1.0.3, build 44) | Proprietary (Alibaba Cloud) | Redistributed unmodified except for the patches in `patches/` and the added `out/main/linux-update.js`. Use is governed by Alibaba's terms for Qwen Chat (<https://chat.qwen.ai/>). Bundles `@ali/aes-tracker` telemetry, disclosed in README.md. |
| Electron 35.1.4 | 35.1.4 | MIT | `LICENSE` from the Electron zip is shipped as `/opt/Qwen Studio/LICENSE`. |
| Chromium (inside Electron) | see Electron | BSD-3-Clause and others | `LICENSES.chromium.html` is shipped next to the Electron binary. |
| bun 1.2.10 (`resources/bun/bun`) | 1.2.10 | MIT | <https://github.com/oven-sh/bun> |
| uv 0.12.15 (`resources/python/uv`, `uvx`) | 0.12.15 | MIT OR Apache-2.0 | <https://github.com/astral-sh/uv> |
| electron-builder (build tool, not shipped) | 26.15.3 | MIT | Generates the deb/rpm/AppImage packages and their install scripts. |
| electron-updater (inside `app.asar`) | 6.6.2 | MIT | Bundled by upstream inside `app.asar`'s own `node_modules`; this is the version that actually runs. This repository's own `electron-updater` devDependency (currently 6.8.9) is a separate, newer copy used only to drive `tests/unit/versions.test.ts` against electron-updater's real update-comparison logic — it is never shipped. |

Wrapper build-time dependencies: run `npm ls --omit=dev` in this repository; none of them are shipped in the release artifacts.
