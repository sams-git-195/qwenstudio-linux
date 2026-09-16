import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { parseControlFields, debControl, debFiles, debExtract } from "../../scripts/lib/deb.js";
import { deriveVersions } from "../../scripts/lib/versions.js";
import { readUpstream } from "../../scripts/lib/manifest.js";
import { DIST_DIR } from "../../scripts/lib/paths.js";

function hasCommand(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).status === 0;
}

// Fixture: verbatim `ar p pkg.deb control.tar.xz | tar -xJO ./control` output, including a
// folded (multi-line) Description field, exactly as electron-builder's fpm-produced .deb emits
// (real fpm output indents continuation lines with two spaces, not the RFC2822-strict one).
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

describe("deb.ts against a synthetic .deb (control.tar.gz + data.tar.zst)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // The only .deb this repo actually builds uses control.tar.xz + data.tar.xz (electron-builder's
  // fpm default), so debControl/debFiles/debExtract's .gz and .zst branches of
  // tarCompressionFlags() otherwise have zero coverage. Build a tiny synthetic .deb with `ar rc`
  // to exercise them directly. Requires `zstd` on PATH (for `tar --zstd`); `ar` and `gzip`-capable
  // `tar` are assumed present everywhere this suite runs.
  it.skipIf(!hasCommand("zstd"))("reads control fields, lists files, and extracts the payload from gz/zst members", () => {
    dir = mkdtempSync(path.join(tmpdir(), "synth-deb-"));
    const ctl = path.join(dir, "ctl");
    const data = path.join(dir, "data");
    mkdirSync(ctl, { recursive: true });
    mkdirSync(path.join(data, "usr/share/doc/synth-test"), { recursive: true });
    mkdirSync(path.join(data, "opt/synth"), { recursive: true });

    writeFileSync(
      path.join(ctl, "control"),
      "Package: synth-test\nVersion: 9.9.9\nArchitecture: amd64\nDescription: synthetic test package\n  a folded continuation line\n",
    );
    writeFileSync(path.join(data, "usr/share/doc/synth-test/readme.txt"), "hello\n");
    writeFileSync(path.join(data, "opt/synth/app.txt"), "world\n");
    writeFileSync(path.join(dir, "debian-binary"), "2.0\n");

    const run = (cmd: string, args: string[]): void => {
      const r = spawnSync(cmd, args, { cwd: dir });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr?.toString() ?? r.error?.message}`);
    };
    run("tar", ["-czf", "control.tar.gz", "-C", ctl, "."]);
    run("tar", ["--zstd", "-cf", "data.tar.zst", "-C", data, "."]);
    run("ar", ["rc", "synth.deb", "debian-binary", "control.tar.gz", "data.tar.zst"]);

    const debPath = path.join(dir, "synth.deb");

    const fields = debControl(debPath);
    expect(fields.Package).toBe("synth-test");
    expect(fields.Version).toBe("9.9.9");
    expect(fields.Description).toBe("synthetic test package\na folded continuation line");

    const files = debFiles(debPath);
    expect(files).toContain("./usr/share/doc/synth-test/readme.txt");
    expect(files).toContain("./opt/synth/app.txt");

    const extractDir = path.join(dir, "extracted");
    debExtract(debPath, extractDir);
    expect(readFileSync(path.join(extractDir, "usr/share/doc/synth-test/readme.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(path.join(extractDir, "opt/synth/app.txt"), "utf8")).toBe("world\n");
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
