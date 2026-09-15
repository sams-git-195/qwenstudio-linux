import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { renderIcons, ICON_SIZES } from "../../scripts/icons.js";

describe("renderIcons", () => {
  it("renders every hicolor size from a square source", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qs-icons-"));
    const src = path.join(dir, "icon.png");
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toFile(src);
    const out = path.join(dir, "out");
    expect(await renderIcons(src, out)).toEqual(ICON_SIZES);
    expect(readdirSync(out).sort()).toEqual(ICON_SIZES.map((n) => `${n}x${n}.png`).sort());
    const meta = await sharp(path.join(out, "512x512.png")).metadata();
    expect([meta.width, meta.height]).toEqual([512, 512]);
  });
  it("rejects a non-square source", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qs-icons-"));
    const src = path.join(dir, "wide.png");
    await sharp({ create: { width: 200, height: 100, channels: 4, background: "#fff" } }).png().toFile(src);
    await expect(renderIcons(src, path.join(dir, "out"))).rejects.toThrow(/square/);
  });
});
