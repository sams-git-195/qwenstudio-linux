import { describe, it, expect } from "vitest";
import { addUnreleased, finalize, unreleasedSection, renderReleaseHeader } from "../../scripts/changelog.js";
import { deriveVersions } from "../../scripts/lib/versions.js";
import { readUpstream, readSidecars } from "../../scripts/lib/manifest.js";

const md = `# Changelog\n\nIntro.\n\n## [Unreleased]\n\n- First.\n\n## [v1.0.3.43-1] - 2026-01-01\n\n- Old.\n`;

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
  it("finalize with an empty Unreleased inserts a placeholder-free section", () => {
    const out = finalize(finalize(md, "v1.0.3.44-1", "2026-09-15"), "v1.0.3.44-2", "2026-09-16");
    expect(out).toContain("## [v1.0.3.44-2] - 2026-09-16\n\n- Wrapper-only release; no changelog entries recorded.\n");
  });
  it("renders the release header", () => {
    const h = renderReleaseHeader(deriveVersions(readUpstream()), readUpstream(), readSidecars(), "abc  qwen-studio_1.0.3.44-1_amd64.deb\n");
    expect(h).toContain("Upstream Qwen Studio **1.0.3** build **44**");
    expect(h).toContain("Electron 35.1.4, bun 1.2.10, uv 0.12.15");
    expect(h).toContain("not affiliated");
    expect(h).toContain("sudo apt install ./qwen-studio_1.0.3.44-1_amd64.deb");
    expect(h).toContain("abc  qwen-studio_1.0.3.44-1_amd64.deb");
  });
});
