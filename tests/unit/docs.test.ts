import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { readSidecars } from "../../scripts/lib/manifest.js";

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

describe("governance documents", () => {
  it("README has the required notices", () => {
    const md = read("README.md");
    for (const s of ["not affiliated", "@ali/aes-tracker", "telemetry", "proprietary", "libfuse2", "--ozone-platform-hint=auto", "SECURITY.md", "CONTRIBUTING.md", "sudo apt install ./", "sudo dnf install ./", "--appimage-extract"]) {
      expect(md, `README.md must mention ${s}`).toContain(s);
    }
  });
  it("LICENSE is MIT for the wrapper only", () => {
    expect(read("LICENSE")).toContain("MIT License");
    expect(read("LICENSE")).toContain("Copyright (c) 2026 sams-git-195");
  });
  it("THIRD_PARTY_NOTICES lists every redistributed component", () => {
    const md = read("THIRD_PARTY_NOTICES.md");
    const sc = readSidecars();
    for (const s of ["Qwen Studio", `Electron ${sc.electron.version}`, "Chromium", `bun ${sc.bun.version}`, `uv ${sc.uv.version}`, "electron-builder"]) {
      expect(md, `THIRD_PARTY_NOTICES.md must mention ${s}`).toContain(s);
    }
  });
});
