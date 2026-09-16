# Qwen Studio for Linux (unofficial)

[![ci](https://github.com/sams-git-195/qwenstudio-linux/actions/workflows/ci.yml/badge.svg)](https://github.com/sams-git-195/qwenstudio-linux/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/sams-git-195/qwenstudio-linux)](https://github.com/sams-git-195/qwenstudio-linux/releases/latest)
[![license](https://img.shields.io/badge/wrapper%20license-MIT-blue)](LICENSE)

Native Linux packages (`.deb`, `.rpm`, `.AppImage`, x86_64) of **Qwen Studio**, Alibaba's desktop client for [chat.qwen.ai](https://chat.qwen.ai/). Upstream ships Windows and macOS builds only; this project repackages the unmodified upstream application on the official Electron 35.1.4 Linux runtime, with two small patches so it runs on Linux.

> **Not affiliated.** This project is not affiliated with, endorsed by or supported by Alibaba Cloud or the Qwen team. "Qwen" is a trademark of its owner. Report problems with the packaging here; report problems with the app or the service to Alibaba.

## Install

Download from the [latest release](https://github.com/sams-git-195/qwenstudio-linux/releases/latest).

| Format | Command |
| --- | --- |
| Debian / Ubuntu | `sudo apt install ./qwen-studio_<version>_amd64.deb` |
| Fedora | `sudo dnf install ./qwen-studio-<version>.x86_64.rpm` |
| AppImage | `chmod +x qwen-studio-<version>-x86_64.AppImage && ./qwen-studio-<version>-x86_64.AppImage` |

The AppImage needs `libfuse2` (Ubuntu 22.04+/Debian: `sudo apt install libfuse2`). Without FUSE, run `./qwen-studio-<version>-x86_64.AppImage --appimage-extract` and start `squashfs-root/AppRun`.

Verify downloads with the `SHA256SUMS` asset (`sha256sum -c SHA256SUMS`) or `gh attestation verify <file> --owner sams-git-195`.

## Updates

- **AppImage:** the app checks this repository's releases at startup and via *Check for updates*; it downloads the new AppImage in-app and installs it on quit (or immediately, if you confirm the upstream dialog).
- **deb / rpm:** the app only *notifies* you and opens the release page; install the new package yourself with `apt`/`dnf`. No `pkexec`/`sudo` prompts are ever triggered by the app.

## Wayland and X11

The desktop entry launches with `--ozone-platform-hint=auto`, so the app runs natively on Wayland and falls back to X11. Starting `qwen-studio` from a terminal launches without the flag (XWayland/X11).

## Telemetry disclosure

The upstream application bundles Alibaba's analytics library `@ali/aes-tracker` and reports usage events to Alibaba. This project neither adds nor removes telemetry; the app behaves exactly as the Windows build in this respect.

## Licensing

Qwen Studio is proprietary software by Alibaba; your use of it is governed by Alibaba's terms for Qwen Chat (see <https://chat.qwen.ai/>). Only the packaging scripts, patches and CI in this repository are MIT-licensed (see [LICENSE](LICENSE)). Redistributed components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## How it works

1. The upstream Windows installer is downloaded from `download.qwen.ai` and verified against the SHA-512 pinned in `upstream.json`.
2. `app.asar` is extracted, two patches from `patches/` are applied (Linux platform detection; updater pointed at this repository), and a small notify-only updater module (`src/app/linux-update.js`) is added.
3. The app is assembled onto the official Electron Linux runtime with Linux builds of `bun` and `uv`/`uvx` (pinned in `sidecars.json`) and packaged with electron-builder.
4. A daily bot checks upstream for new versions and opens an auto-merging pull request; merges to `main` publish releases automatically.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/RELEASING.md](docs/RELEASING.md).

## Building locally

    nvm use && npm ci && npm run build && npm run verify

The build fetches upstream artifacts (~300 MB on first run, cached in `.cache/`) and needs `7z`, `unzip`, `tar`, `xz`, `zstd`, `rpm`, `rpm2cpio`, `cpio`, `desktop-file-validate` and `binutils` (`ar`/`readelf`) on `PATH`; `dpkg` is not required. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full per-distro package lists.

## Security

See [SECURITY.md](SECURITY.md) for where to report packaging vulnerabilities versus upstream application vulnerabilities.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
