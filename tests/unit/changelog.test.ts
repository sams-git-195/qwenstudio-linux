import { describe, it, expect } from "vitest";
import { addUnreleased, finalize, unreleasedSection, renderReleaseHeader, parseArgs } from "../../scripts/changelog.js";
import { deriveVersions } from "../../scripts/lib/versions.js";
import type { UpstreamManifest, SidecarsManifest } from "../../scripts/lib/manifest.js";

const md = `# Changelog\n\nIntro.\n\n## [Unreleased]\n\n- First.\n\n## [v1.0.3.43-1] - 2026-01-01\n\n- Old.\n`;

// Fixed fixtures, independent of the live upstream.json/sidecars.json: the first automated
// upstream bump rewrites those files but not this test, so asserting literals derived from a
// live read here would turn CI red and block auto-merge (Section 12.3 step 8). Values are
// deliberately different from whatever the current live manifests happen to say.
const upstreamFixture: UpstreamManifest = {
  version: "9.9.9",
  build: 7,
  wrapper_revision: 2,
  url: "https://download.qwen.ai/windows/x64/Qwen-9.9.9.7-release-win-x64.exe",
  sha512: "i9mh4W2lC2YzTcV5L4uaMwwWj9pthH/uIZEi1/MuxtLIyC53ZFgrETzdACJMECAwnI0VtYOLlI/gHm+gsfj8qA==",
  size: 1,
  releaseDate: "2026-02-02T00:00:00.000Z",
};
const sidecarsFixture: SidecarsManifest = {
  electron: { version: "99.0.0", url: "https://example.com/electron.zip", sha256: "a".repeat(64) },
  bun: { version: "9.9.9", url: "https://example.com/bun.zip", sha256: "b".repeat(64) },
  uv: { version: "9.9.9", url: "https://example.com/uv.tar.gz", sha256: "c".repeat(64) },
};

describe("changelog", () => {
  it("adds a line under Unreleased", () => {
    const out = addUnreleased(md, "Upstream bump to 1.0.3.45 (released 2026-09-01T00:00:00.000Z)");
    expect(unreleasedSection(out)).toBe("- Upstream bump to 1.0.3.45 (released 2026-09-01T00:00:00.000Z)\n- First.\n");
  });
  it("finalizes Unreleased into a tagged section and leaves Unreleased empty", () => {
    const out = finalize(md, "v1.0.3.44-1", "2026-09-15");
    expect(out).toContain("## [Unreleased]\n\n## [v1.0.3.44-1] - 2026-09-15\n\n- First.\n\n## [v1.0.3.43-1] - 2026-01-01");
    expect(unreleasedSection(out)).toBe("");
  });
  it("finalize with an empty Unreleased inserts the wrapper-only placeholder", () => {
    const out = finalize(finalize(md, "v1.0.3.44-1", "2026-09-15"), "v1.0.3.44-2", "2026-09-16");
    expect(out).toContain("## [v1.0.3.44-2] - 2026-09-16\n\n- Wrapper-only release; no changelog entries recorded.\n");
  });
  it("finalize when Unreleased is the last section leaves no stray trailing blank line", () => {
    const lastSection = `# Changelog\n\nIntro.\n\n## [Unreleased]\n\n- Only entry.\n`;
    const out = finalize(lastSection, "v1.0.0-1", "2026-01-01");
    expect(out).toBe(`# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [v1.0.0-1] - 2026-01-01\n\n- Only entry.\n`);
    expect(unreleasedSection(out)).toBe("");
  });
  it("renders the release header from fixture manifests (not the live upstream.json/sidecars.json)", () => {
    const v = deriveVersions(upstreamFixture);
    const h = renderReleaseHeader(v, upstreamFixture, sidecarsFixture, "abc  qwen-studio_9.9.9.7-2_amd64.deb\n");
    expect(h).toContain("Upstream Qwen Studio **9.9.9** build **7**");
    expect(h).toContain("Electron 99.0.0, bun 9.9.9, uv 9.9.9");
    expect(h).toContain("not affiliated");
    expect(h).toContain("sudo apt install ./qwen-studio_9.9.9.7-2_amd64.deb");
    expect(h).toContain("abc  qwen-studio_9.9.9.7-2_amd64.deb");
  });
});

describe("parseArgs", () => {
  it("parses --add <line>", () => {
    expect(parseArgs(["--add", "Some entry"])).toEqual({ mode: "add", line: "Some entry" });
  });
  it("parses --finalize <tag>", () => {
    expect(parseArgs(["--finalize", "v1.0.0-1"])).toEqual({ mode: "finalize", tag: "v1.0.0-1" });
  });
  it("parses --release-notes <file>", () => {
    expect(parseArgs(["--release-notes", "/tmp/SHA256SUMS"])).toEqual({ mode: "release-notes", file: "/tmp/SHA256SUMS" });
  });
  it("throws a usage error for --add with no line", () => {
    expect(() => parseArgs(["--add"])).toThrow(/^usage: changelog/);
  });
  it("throws a usage error for --finalize with no tag", () => {
    expect(() => parseArgs(["--finalize"])).toThrow(/^usage: changelog/);
  });
  it("throws a usage error for --release-notes with no file", () => {
    expect(() => parseArgs(["--release-notes"])).toThrow(/^usage: changelog/);
  });
  it("throws a usage error for an unrecognized flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/^usage: changelog/);
  });
  it("throws a usage error for no args at all", () => {
    expect(() => parseArgs([])).toThrow(/^usage: changelog/);
  });
});
