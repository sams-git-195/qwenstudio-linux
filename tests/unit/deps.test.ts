import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const exe = "build/linux-unpacked/qwen-studio";
const base = JSON.parse(readFileSync("packaging/electron-builder.base.json", "utf8"));
const table: Record<string, string> = JSON.parse(readFileSync("tests/fixtures/soname-to-deb.json", "utf8"));

describe.skipIf(!existsSync(exe))("deb depends cover ldd of the Electron binary (needs build/linux-unpacked)", () => {
  it("every direct runtime soname maps to a declared deb dependency", () => {
    // `ldd` reports the full *transitive* closure of resolved shared libraries, not just the
    // sonames qwen-studio itself links against. On a fully-loaded desktop host (e.g. Fedora, used
    // to capture this), libraries like libgbm.so.1 or libgtk-3.so.0 pull in dozens of further
    // sonames (libdrm, libsystemd, libgnutls, libtinysparql, libglycin, ...) that are dependencies
    // of *those* packages, not of qwen-studio - Debian's libgbm1/libgtk-3-0 already declare their
    // own Depends covering them, and several of those Fedora-side sonames (libtinysparql,
    // libglycin, libcloudproviders) don't even correspond 1:1 to Debian/Ubuntu package names. So we
    // intersect ldd's resolved sonames with `readelf -d`'s DT_NEEDED entries (qwen-studio's own
    // direct dependencies) and only require *those* to be covered here.
    const lddOut = execFileSync("ldd", [exe], { encoding: "utf8" });
    const resolved = new Set(
      lddOut
        .split("\n")
        .filter((l) => l.includes("=>"))
        .map((l) => l.trim().split(/\s+/)[0]),
    );
    const readelfOut = execFileSync("readelf", ["-d", exe], { encoding: "utf8" });
    const needed = [...readelfOut.matchAll(/\(NEEDED\)\s+Shared library: \[(.+?)\]/g)].map((m) => m[1]);

    const sonames = needed.filter((so) => resolved.has(so));
    const unmapped: string[] = [];
    const undeclared: string[] = [];
    for (const so of sonames) {
      if (existsSync(`build/linux-unpacked/${so}`)) continue; // bundled with Electron
      const pkg = table[so];
      if (!pkg) {
        unmapped.push(so);
        continue;
      }
      if (!base.deb.depends.includes(pkg)) undeclared.push(`${so} -> ${pkg}`);
    }
    expect(unmapped, "add these sonames to tests/fixtures/soname-to-deb.json").toEqual([]);
    expect(undeclared, "add these packages to deb.depends in packaging/electron-builder.base.json").toEqual([]);
  });
});

describe("dependency lists are well-formed", () => {
  it("contain electron-builder's defaults", () => {
    for (const p of ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0"])
      expect(base.deb.depends).toContain(p);
    for (const p of ["gtk3", "libnotify", "nss", "libXScrnSaver", "libXtst", "xdg-utils", "at-spi2-core", "libuuid", "libsecret"])
      expect(base.rpm.depends).toContain(p);
  });
  it("have no duplicates", () => {
    expect(new Set(base.deb.depends).size).toBe(base.deb.depends.length);
    expect(new Set(base.rpm.depends).size).toBe(base.rpm.depends.length);
  });
});
