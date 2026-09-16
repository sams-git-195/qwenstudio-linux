import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetchCached, ChecksumMismatchError } from "../../scripts/lib/download.js";
import { sha256File, sha512Base64File } from "../../scripts/lib/hash.js";

const body = Buffer.from("hello qwen studio");
const sha256 = createHash("sha256").update(body).digest("hex");
const sha512b64 = createHash("sha512").update(body).digest("base64");
let server: http.Server; let base = ""; let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.url === "/flaky" && hits === 1) { res.destroy(); return; }
    res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("fetchCached", () => {
  it("downloads, verifies and caches", async () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "qs-cache-"));
    const p = await fetchCached({ url: `${base}/file.bin`, algo: "sha256", expected: sha256, cacheDir });
    expect(p).toBe(path.join(cacheDir, sha256.slice(0, 12), "file.bin"));
    expect(readFileSync(p)).toEqual(body);
    const before = hits;
    await fetchCached({ url: `${base}/file.bin`, algo: "sha256", expected: sha256, cacheDir });
    expect(hits).toBe(before);
  });
  it("verifies sha512 base64", async () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "qs-cache-"));
    const p = await fetchCached({ url: `${base}/f.exe`, algo: "sha512", expected: sha512b64, cacheDir });
    expect(await sha512Base64File(p)).toBe(sha512b64);
    expect(await sha256File(p)).toBe(sha256);
  });
  it("deletes the file and throws on mismatch", async () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "qs-cache-"));
    const bad = "0".repeat(64);
    await expect(fetchCached({ url: `${base}/x.bin`, algo: "sha256", expected: bad, cacheDir })).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(existsSync(path.join(cacheDir, bad.slice(0, 12), "x.bin"))).toBe(false);
  });
  it("retries on network errors", async () => {
    hits = 0;
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "qs-cache-"));
    const p = await fetchCached({ url: `${base}/flaky`, algo: "sha256", expected: sha256, cacheDir, backoffMs: 1 });
    expect(readFileSync(p)).toEqual(body);
  });
});
