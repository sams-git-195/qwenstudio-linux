# Security policy

## Supported versions

Only the latest GitHub Release is supported. Older releases are not patched.

## Reporting a vulnerability in the packaging

Problems in this repository's scripts, patches, CI, install scripts, or in how the packages are built and attested: use GitHub's private vulnerability reporting for this repository (Security tab → "Report a vulnerability").

> Private vulnerability reporting must be enabled by the repository owner (`sams-git-195`) in Settings → Security → "Private vulnerability reporting" before this option appears. If it is not yet enabled, open a regular issue that omits exploit details and ask to be contacted privately, or email `samheard95@gmail.com`.

## Reporting a vulnerability in Qwen Studio or chat.qwen.ai

This project does not develop the application; it only repackages the upstream Windows build for Linux with the minimal patches in `patches/` and `src/app/linux-update.js`. Vulnerabilities in the app itself, its embedded web content, its telemetry (`@ali/aes-tracker`), or the [chat.qwen.ai](https://chat.qwen.ai/) service are Alibaba Cloud's to fix — report them through the [Alibaba Security Response Center](https://security.alibaba.com/), not this repository. We cannot patch upstream's proprietary code beyond what is already in `patches/`, and will not accept embargoed upstream vulnerability details here.

## Build integrity

- The upstream Windows installer is verified against the SHA-512 pinned in `upstream.json` before it is unpacked.
- The `bun` and `uv`/`uvx` sidecars are verified against the SHA-256 hashes pinned in `sidecars.json`.
- Every release publishes a `SHA256SUMS` asset alongside the `.deb`, `.rpm` and `.AppImage` files.
- Every release carries a GitHub build provenance attestation for those three package files, verifiable with:

      gh attestation verify <file> --owner sams-git-195
