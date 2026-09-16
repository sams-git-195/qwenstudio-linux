import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("tooling", () => {
  it("ignores installers", () => {
    expect(readFileSync(".gitignore", "utf8").split("\n")).toContain("*.exe");
  });
});
