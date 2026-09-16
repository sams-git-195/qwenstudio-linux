import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateUpstream, validateSidecars, readUpstream, readSidecars } from "../../scripts/lib/manifest.js";

const good = JSON.parse(readFileSync("upstream.json", "utf8"));
const sidecars = JSON.parse(readFileSync("sidecars.json", "utf8"));

describe("validateUpstream", () => {
  it("accepts the committed manifest", () => {
    expect(validateUpstream(good)).toEqual(good);
    expect(readUpstream()).toEqual(good);
  });
  it("rejects a missing field", () => {
    const { build, ...rest } = good;
    expect(() => validateUpstream(rest)).toThrow(/upstream\.json: missing or invalid field "build"/);
  });
  it("rejects bad base64 sha512", () => {
    expect(() => validateUpstream({ ...good, sha512: "abc" })).toThrow(/sha512/);
  });
  it("rejects a non-download.qwen.ai URL", () => {
    expect(() => validateUpstream({ ...good, url: "https://example.com/x.exe" })).toThrow(/url/);
  });
  it("rejects a URL containing /latest/", () => {
    expect(() => validateUpstream({ ...good, url: "https://download.qwen.ai/latest/x.exe" })).toThrow(/latest/);
  });
});

describe("validateSidecars", () => {
  it("accepts the committed manifest", () => {
    expect(validateSidecars(sidecars)).toEqual(sidecars);
    expect(readSidecars()).toEqual(sidecars);
  });
  it("rejects /latest/ URLs", () => {
    const bad = { ...sidecars, uv: { ...sidecars.uv, url: "https://github.com/astral-sh/uv/releases/latest/download/uv.tar.gz" } };
    expect(() => validateSidecars(bad)).toThrow(/latest/);
  });
  it("rejects a non-hex sha256", () => {
    const bad = { ...sidecars, bun: { ...sidecars.bun, sha256: "zz" } };
    expect(() => validateSidecars(bad)).toThrow(/sha256/);
  });
});
