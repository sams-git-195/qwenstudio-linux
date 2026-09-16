// Portable .deb inspection without a `dpkg-deb` dependency (Fedora dev hosts don't have it
// and can't install it; CI's Ubuntu runners do, but this project's tooling must work on both).
// A .deb is an `ar` archive of `debian-binary`, `control.tar.<ext>`, `data.tar.<ext>`, where
// `<ext>` varies by build (xz/gz/zst). We shell out to `ar` + `tar`, which are present
// everywhere, instead of `dpkg-deb`.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

// data.tar.* (the payload) is the largest member we read into memory; give it plenty of
// headroom above today's real size (~128 MB compressed) since this is a build-time tool,
// not a hot path, and a too-small buffer would fail loudly (ENOBUFS) rather than silently.
const MAX_BUFFER = 1024 * 1024 * 1024;

function arMembers(deb: string): string[] {
  const r = spawnSync("ar", ["t", deb], { encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (r.error) throw new Error(`ar t ${deb}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ar t ${deb} exited with ${r.status}: ${(r.stderr ?? "").trim()}`);
  return r.stdout.split("\n").filter(Boolean);
}

function findMember(deb: string, prefix: string): string {
  const members = arMembers(deb);
  const found = members.find((m) => m.startsWith(prefix));
  if (!found) throw new Error(`${deb}: no ar member starting with "${prefix}" (found: ${members.join(", ")})`);
  return found;
}

// tar's compression flag for a member name, e.g. "control.tar.xz" -> "-J".
function tarCompressionFlags(member: string): string[] {
  if (/\.xz$/.test(member)) return ["-J"];
  if (/\.(gz|tgz)$/.test(member)) return ["-z"];
  if (/\.zst(d)?$/.test(member)) return ["--zstd"];
  if (/\.tar$/.test(member)) return [];
  throw new Error(`unsupported ar member compression: ${member}`);
}

function readArMember(deb: string, member: string): Buffer {
  const r = spawnSync("ar", ["p", deb, member], { maxBuffer: MAX_BUFFER });
  if (r.error) throw new Error(`ar p ${deb} ${member}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ar p ${deb} ${member} exited with ${r.status}: ${(r.stderr ?? "").toString().trim()}`);
  return r.stdout;
}

function tar(input: Buffer, args: string[]): Buffer {
  const r = spawnSync("tar", args, { input, maxBuffer: MAX_BUFFER });
  if (r.error) throw new Error(`tar ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar ${args.join(" ")} exited with ${r.status}: ${(r.stderr ?? "").toString().trim()}`);
  return r.stdout;
}

/**
 * Parse a Debian control file's RFC2822-style field syntax ("Key: value", with
 * continuation lines indented by leading whitespace) into a flat key/value map.
 * Exported and unit-tested directly on fixture strings, independent of `ar`/`tar`.
 */
export function parseControlFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") continue;
    if (/^[ \t]/.test(rawLine)) {
      if (currentKey === null) continue; // stray continuation before any field; ignore
      // Real fpm-produced control files indent continuation lines with two spaces (not the
      // single space of the strict RFC2822 fold rule), so strip all leading whitespace, not
      // just one character.
      const cont = rawLine.replace(/^[ \t]+/, "");
      out[currentKey] += `\n${cont === "." ? "" : cont}`;
      continue;
    }
    const m = /^([A-Za-z0-9-]+):[ \t]?(.*)$/.exec(rawLine);
    if (!m) continue;
    currentKey = m[1];
    out[currentKey] = m[2];
  }
  return out;
}

/** Debian control fields (Package, Version, Architecture, ...) from a .deb's control.tar.*. */
export function debControl(deb: string): Record<string, string> {
  const member = findMember(deb, "control.tar");
  const out = tar(readArMember(deb, member), ["-x", ...tarCompressionFlags(member), "-f", "-", "-O", "./control"]);
  return parseControlFields(out.toString("utf8"));
}

/** Every path in the .deb's payload (data.tar.*), each prefixed "./" as tar lists them. */
export function debFiles(deb: string): string[] {
  const member = findMember(deb, "data.tar");
  const out = tar(readArMember(deb, member), ["-t", ...tarCompressionFlags(member), "-f", "-"]);
  return out.toString("utf8").split("\n").filter(Boolean);
}

/** Extract the .deb's payload (data.tar.*) into `dir`. */
export function debExtract(deb: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const member = findMember(deb, "data.tar");
  tar(readArMember(deb, member), ["-x", ...tarCompressionFlags(member), "-f", "-", "-C", dir]);
}
