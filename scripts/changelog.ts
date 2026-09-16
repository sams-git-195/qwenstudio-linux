import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readUpstream, readSidecars, type UpstreamManifest, type SidecarsManifest } from "./lib/manifest.js";
import { deriveVersions, type DerivedVersions } from "./lib/versions.js";
import { ROOT, BUILD_DIR } from "./lib/paths.js";

const UNRELEASED = "## [Unreleased]";
const WRAPPER_ONLY = "- Wrapper-only release; no changelog entries recorded.\n";

function splitAtUnreleased(md: string): { head: string; body: string; rest: string } {
  const i = md.indexOf(UNRELEASED);
  if (i === -1) throw new Error("CHANGELOG.md has no '## [Unreleased]' section");
  const afterHeading = i + UNRELEASED.length;
  const next = md.indexOf("\n## ", afterHeading);
  const body = next === -1 ? md.slice(afterHeading) : md.slice(afterHeading, next + 1);
  const rest = next === -1 ? "" : md.slice(next + 1);
  return { head: md.slice(0, afterHeading), body, rest };
}

/** The Unreleased section's bullet lines, normalized to a trailing single newline ("" if empty). */
export function unreleasedSection(md: string): string {
  const items = splitAtUnreleased(md).body.replace(/^\n+/, "").replace(/\n+$/, "");
  return items === "" ? "" : `${items}\n`;
}

export function addUnreleased(md: string, line: string): string {
  const { head, rest } = splitAtUnreleased(md);
  const items = unreleasedSection(md);
  return `${head}\n\n- ${line}\n${items}${rest ? `\n${rest}` : ""}`;
}

export function finalize(md: string, tag: string, date: string): string {
  const { head, rest } = splitAtUnreleased(md);
  const items = unreleasedSection(md) || WRAPPER_ONLY;
  return `${head}\n\n## [${tag}] - ${date}\n\n${items}${rest ? `\n${rest}` : ""}`;
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
  if (argv[0] === "--add") {
    writeFileSync(changelogPath, addUnreleased(md, argv[1]));
    console.log("CHANGELOG.md: added unreleased entry");
    return;
  }
  if (argv[0] === "--finalize") {
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(changelogPath, finalize(md, argv[1], date));
    console.log(`CHANGELOG.md: finalized ${argv[1]} (${date})`);
    return;
  }
  if (argv[0] === "--release-notes") {
    const up = readUpstream();
    const v = deriveVersions(up);
    const header = renderReleaseHeader(v, up, readSidecars(), readFileSync(argv[1], "utf8"));
    const items = unreleasedSection(md) || WRAPPER_ONLY;
    mkdirSync(BUILD_DIR, { recursive: true });
    writeFileSync(path.join(BUILD_DIR, "notes.md"), `${header}\n### Changes\n\n${items}\n`);
    console.log("wrote build/notes.md");
    return;
  }
  console.error("usage: changelog --add <line> | --finalize <tag> | --release-notes <SHA256SUMS>");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
