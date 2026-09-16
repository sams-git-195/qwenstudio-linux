import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFeed } from "../../scripts/lib/manifest.js";

const FEED = "https://download.qwen.ai/windows/x64/latest.yml";

describe("parseFeed", () => {
  it("parses the verbatim upstream feed", () => {
    const info = parseFeed(readFileSync("tests/fixtures/latest.yml", "utf8"), FEED);
    expect(info).toEqual({
      version: "1.0.3",
      build: 44,
      url: "https://download.qwen.ai/windows/x64/Qwen-1.0.3.44-release-win-x64.exe",
      sha512: "i9mh4W2lC2YzTcV5L4uaMwwWj9pthH/uIZEi1/MuxtLIyC53ZFgrETzdACJMECAwnI0VtYOLlI/gHm+gsfj8qA==",
      size: 124943360,
      releaseDate: "2025-08-15T03:38:13.875Z",
    });
  });
  it("rejects a filename that does not match the installer pattern", () => {
    expect(() => parseFeed(readFileSync("tests/fixtures/latest-bad-filename.yml", "utf8"), FEED)).toThrow(/does not match/);
  });
  it("rejects a version/filename mismatch", () => {
    const text = readFileSync("tests/fixtures/latest.yml", "utf8").replace("version: 1.0.3", "version: 1.0.4");
    expect(() => parseFeed(text, FEED)).toThrow(/mismatch/);
  });
  it("resolves absolute file URLs as-is", () => {
    const text = readFileSync("tests/fixtures/latest.yml", "utf8").replace(
      "- url: Qwen-1.0.3.44-release-win-x64.exe",
      "- url: https://cdn.example.com/Qwen-1.0.3.44-release-win-x64.exe",
    );
    expect(parseFeed(text, FEED).url).toBe("https://cdn.example.com/Qwen-1.0.3.44-release-win-x64.exe");
  });
});
