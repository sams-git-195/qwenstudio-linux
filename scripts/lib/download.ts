import { mkdirSync, existsSync, rmSync, createWriteStream, renameSync } from "node:fs";
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
