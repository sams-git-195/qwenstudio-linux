import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectElectronVersion } from "../../scripts/extract.js";

describe("detectElectronVersion", () => {
  it("finds the Electron/x.y.z marker in a binary", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qs-exe-"));
    const p = path.join(dir, "fake.exe");
    writeFileSync(p, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("Chrome/134.0.6998.179 Electron/35.1.4 Safari"), Buffer.from([0, 0])]));
    expect(detectElectronVersion(p)).toBe("35.1.4");
  });
  it("throws when no marker exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qs-exe-"));
    const p = path.join(dir, "fake.exe");
    writeFileSync(p, "nothing here");
    expect(() => detectElectronVersion(p)).toThrow(/Electron version marker not found/);
  });
});
