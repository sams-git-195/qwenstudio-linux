import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

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
    for (const s of ["Qwen Studio", "Electron 35.1.4", "Chromium", "bun 1.2.10", "uv 0.12.15", "electron-builder"]) expect(md).toContain(s);
  });
});
