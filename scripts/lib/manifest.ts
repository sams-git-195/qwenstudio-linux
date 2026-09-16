import { readFileSync } from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

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
