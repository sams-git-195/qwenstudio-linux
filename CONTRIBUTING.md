# Contributing

## Development setup

Fedora:

    sudo dnf install -y git nodejs-npm p7zip p7zip-plugins unzip rpm-build rpm desktop-file-utils cpio binutils xz zstd jq xorg-x11-server-Xvfb xorg-x11-xauth curl

Ubuntu/Debian:

    sudo apt install -y git p7zip-full unzip rpm desktop-file-utils cpio binutils xz-utils zstd jq xvfb xauth curl libfuse2

Node 22 via nvm: `nvm install 22 && nvm use`. Then:

    npm ci
    npm run typecheck && npm run test:unit
    npm run build          # downloads ~300 MB into .cache/ on first run, writes dist/
    npm run verify
    BUN_VERSION=$(jq -r .bun.version sidecars.json) UV_VERSION=$(jq -r .uv.version sidecars.json) \
      tests/smoke/smoke.sh build/linux-unpacked/qwen-studio build/linux-unpacked/resources

`smoke.sh` asserts the bundled `bun`/`uv` versions against `BUN_VERSION`/`UV_VERSION`; CI derives them from `sidecars.json` exactly like this (`.github/workflows/build-and-test.yml`), and the script's built-in defaults are only a fallback that mirrors `sidecars.json`.

`npm run build`/`npm run verify` need `7z`, `unzip`, `tar`, `xz`, `zstd`, `rpm`, `rpm2cpio`, `cpio` and `desktop-file-validate` on `PATH`; `tests/unit/deps.test.ts` needs `readelf` (from `binutils`). `dpkg` is not required.

Container install tests (any one leg, requires podman or docker): `docker run --rm --shm-size=1g -v "$PWD/dist:/dist:ro" -v "$PWD/tests:/tests:ro" -e BUN_VERSION="$(jq -r .bun.version sidecars.json)" -e UV_VERSION="$(jq -r .uv.version sidecars.json)" ubuntu:24.04 bash /tests/install/install-and-smoke.sh deb`. Other legs: `rpm` (on a `fedora` image) and `appimage`; the full matrix (deb on Ubuntu 22.04/24.04 and Debian 12, rpm on Fedora 40/41, AppImage on Ubuntu 22.04 and Fedora 41) is what CI runs via `tests/install/install-and-smoke.sh`.

## Patches

Patches in `patches/` are unified diffs applied with `git apply` to the unpacked `app.asar`.

1. `npm run patches:dev` — prepares `build/app-pristine/` (untouched) and `build/app/` (patched).
2. Edit `build/app/out/main/index.js`.
3. `npm run patches:export -- 0002` (or `0001`) regenerates the patch file from your edits.
4. `npm run test:unit` — `tests/unit/patch.test.ts` applies the patches to the committed pristine fixture.

Keep patches minimal: only what is required to run on Linux and to point the updater at this repository.

## Commits and pull requests

- Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `build:`, `test:`, `chore:`), enforced by commitlint on PRs; the PR title must also be conventional (squash merges use it).
- Every PR runs unit tests via the required `ci-status` check. PRs touching anything besides docs (`docs/**`, `**/*.md`, `.github/ISSUE_TEMPLATE/**`, `LICENSE`, `CODEOWNERS`) also run the full build and the install matrix.
- Wrapper-only changes are released only when `wrapper_revision` in `upstream.json` is incremented (see [docs/RELEASING.md](docs/RELEASING.md)).
- No DCO or CLA is required.
