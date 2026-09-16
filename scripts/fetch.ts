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
