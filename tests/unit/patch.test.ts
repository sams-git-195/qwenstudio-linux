import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyPatches } from "../../scripts/patch.js";

describe("patches", () => {
  it("apply in sequence to the pristine upstream fixture", () => {
    const pristine = path.resolve("tests/fixtures/app-pristine");
    const work = mkdtempSync(path.join(os.tmpdir(), "qs-patch-"));
    cpSync(pristine, work, { recursive: true });
    const applied = applyPatches(work, pristine);
    expect(applied).toEqual(readdirSync("patches").filter((f) => f.endsWith(".patch")).sort());
    const js = readFileSync(path.join(work, "out/main/index.js"), "utf8");
    expect(js).toContain('return arch === "arm64" ? "linux-arm64" : "linux-x64";');
    expect(js).toContain('require("./linux-update.js")');
    expect(js).toContain("allowPrerelease = false");
    expect(js).toContain("autoInstallOnAppQuit = !!process.env.APPIMAGE");
    expect((js.match(/linuxUpdate\.isNotifyOnly\(\)/g) ?? []).length).toBe(2);
  });
  it("git apply --check rejects the patches against an already-patched tree", () => {
    const pristine = path.resolve("tests/fixtures/app-pristine");
    const work = mkdtempSync(path.join(os.tmpdir(), "qs-patch-"));
    cpSync(pristine, work, { recursive: true });
    applyPatches(work, pristine);
    expect(() => execFileSync("git", ["apply", "--check", path.resolve("patches/0001-linux-platform-dir.patch")], { cwd: work, stdio: "pipe" })).toThrow();
  });
});
