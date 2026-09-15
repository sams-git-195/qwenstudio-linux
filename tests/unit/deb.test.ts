import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseControlFields, debControl, debFiles, debExtract } from "../../scripts/lib/deb.js";
import { deriveVersions } from "../../scripts/lib/versions.js";
import { readUpstream } from "../../scripts/lib/manifest.js";
import { DIST_DIR } from "../../scripts/lib/paths.js";

// Fixture: verbatim `ar p pkg.deb control.tar.xz | tar -xJO ./control` output, including a
// folded (multi-line) Description field, exactly as electron-builder's fpm-produced .deb emits.
const CONTROL_FIXTURE = `Package: qwen-studio
Version: 1.0.3.44-1
License: MIT
Vendor: sams-git-195 (unofficial)
Architecture: amd64
Maintainer: sams-git-195 <samheard95@gmail.com>
Installed-Size: 440392
Depends: libgtk-3-0, libnotify4, libnss3
Recommends: libappindicator3-1
Section: net
Priority: optional
Homepage: https://github.com/sams-git-195/qwenstudio-linux
Description: Desktop client for Qwen Chat (unofficial Linux packaging)
 Unofficial Linux packaging of Qwen Studio, Alibaba's desktop client for chat.qwen.ai.
 .
 Not affiliated with Alibaba Cloud.
`;

describe("parseControlFields", () => {
  it("parses simple Key: value fields", () => {
    const f = parseControlFields(CONTROL_FIXTURE);
    expect(f.Package).toBe("qwen-studio");
    expect(f.Version).toBe("1.0.3.44-1");
    expect(f.Architecture).toBe("amd64");
    expect(f.Homepage).toBe("https://github.com/sams-git-195/qwenstudio-linux");
  });
  it("folds continuation lines into the preceding field, treating a lone '.' as a blank line", () => {
    const f = parseControlFields(CONTROL_FIXTURE);
    expect(f.Description).toBe(
      "Desktop client for Qwen Chat (unofficial Linux packaging)\n" +
        "Unofficial Linux packaging of Qwen Studio, Alibaba's desktop client for chat.qwen.ai.\n" +
        "\n" +
        "Not affiliated with Alibaba Cloud.",
    );
  });
  it("ignores blank lines and stray continuations with no preceding key", () => {
    expect(parseControlFields("\nPackage: foo\n")).toEqual({ Package: "foo" });
    expect(parseControlFields(" stray\nPackage: foo\n")).toEqual({ Package: "foo" });
  });
});

const debPath = (() => {
  try {
    const v = deriveVersions(readUpstream());
    return path.join(DIST_DIR, v.artifacts.deb);
  } catch {
    return "";
  }
})();

describe.skipIf(!debPath || !existsSync(debPath))("deb.ts against the real built .deb", () => {
  it("debControl reads real control fields via ar+tar", () => {
    const f = debControl(debPath);
    expect(f.Package).toBe("qwen-studio");
    expect(f.Architecture).toBe("amd64");
  });
  it("debFiles lists the payload including the desktop entry", () => {
    const files = debFiles(debPath);
    expect(files).toContain("./usr/share/applications/qwen-studio.desktop");
  });
  it("debExtract extracts the payload to a directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deb-extract-"));
    try {
      debExtract(debPath, dir);
      expect(existsSync(path.join(dir, "usr/share/applications/qwen-studio.desktop"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
