import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildConfig, TARGETS, PACKAGE_LICENSE } from "../../scripts/lib/electron-builder-config.js";
import { deriveVersions } from "../../scripts/lib/versions.js";
import { readSidecars } from "../../scripts/lib/manifest.js";

const v = deriveVersions({ version: "1.0.3", build: 44, wrapper_revision: 1 });

describe("packaging/electron-builder.base.json", () => {
  it("does not hardcode electronVersion (sidecars.json is the single source of truth)", () => {
    const base = JSON.parse(readFileSync(path.join(process.cwd(), "packaging", "electron-builder.base.json"), "utf8"));
    expect("electronVersion" in base).toBe(false);
  });
  it("does not set linux.desktop.entry.Categories (electron-builder ignores it and always derives Categories from linux.category; app-builder-lib's LinuxTargetHelper computes desktopMeta.Categories from targetSpecificOptions.category after merging desktop.entry, so a Categories key there is dead and would mislead)", () => {
    const base = JSON.parse(readFileSync(path.join(process.cwd(), "packaging", "electron-builder.base.json"), "utf8"));
    expect("Categories" in (base.linux?.desktop?.entry ?? {})).toBe(false);
  });
  it("declares the mixed proprietary/MIT license for both fpm targets (package.json's MIT covers the packaging only)", () => {
    const base = JSON.parse(readFileSync(path.join(process.cwd(), "packaging", "electron-builder.base.json"), "utf8"));
    // electron-builder emits `--license <package.json license>` first and fpm keeps the LAST
    // --license, so these entries must exist for the shipped metadata to stop saying "MIT".
    expect(base.deb.fpm.slice(0, 2)).toEqual(["--license", PACKAGE_LICENSE]);
    expect(base.rpm.fpm.slice(0, 2)).toEqual(["--license", PACKAGE_LICENSE]);
    expect(PACKAGE_LICENSE).toContain("Proprietary");
    expect(PACKAGE_LICENSE).toContain("MIT");
  });
});

describe("buildConfig", () => {
  it("lists the three targets", () => expect(TARGETS).toEqual(["AppImage", "deb", "rpm"]));
  it("generates the deb config", () => {
    const c = buildConfig("deb", v) as Record<string, any>;
    expect(c.linux.target).toEqual(["deb"]);
    expect(c.linux.category).toBe("Network;Chat");
    expect(c.directories).toEqual({ buildResources: "packaging", output: "dist/deb" });
    expect(c.extraMetadata).toEqual({ name: "qwen-studio", version: "1.0.3-44.1", description: c.linux.description, homepage: "https://github.com/sams-git-195/qwenstudio-linux" });
    expect(c.deb.artifactName).toBe("qwen-studio_1.0.3.44-1_amd64.deb");
    // --license first: it must come after electron-builder's own `--license MIT` (from
    // package.json) so fpm's last-wins semantics make the mixed license the shipped one.
    expect(c.deb.fpm).toEqual(["--license", PACKAGE_LICENSE, "--version", "1.0.3.44", "--iteration", "1"]);
    expect(c.linux.executableArgs).toEqual(["--ozone-platform-hint=auto"]);
    // Debian control alternation, not two separate deps: on Ubuntu 24.04 a plain "libasound2"
    // dependency is ambiguous between libasound2t64 (real ALSA) and liboss4-salsa-asound2 (an
    // OSS-compat shim that also Provides: libasound2 but is missing symbols electron needs, e.g.
    // snd_device_name_get_hint) -- apt can pick either to satisfy an unqualified "libasound2"
    // dependency, so the real package must be listed first.
    expect(c.deb.depends).toContain("libasound2t64 | libasound2");
  });
  it("generates the rpm config", () => {
    const c = buildConfig("rpm", v) as Record<string, any>;
    expect(c.rpm.artifactName).toBe("qwen-studio-1.0.3.44-1.x86_64.rpm");
    // --rpm-auto-add-directories: without it fpm's rpm backend only lists files in %files, not
    // their containing directories, so `dnf remove` leaves empty dirs (e.g. /opt/Qwen Studio and
    // its locales/resources subdirs) behind because rpm never took ownership of them to clean up.
    // --license: same reasoning as the deb case above (overrides package.json's MIT).
    expect(c.rpm.fpm).toEqual(["--license", PACKAGE_LICENSE, "--rpm-auto-add-directories", "--version", "1.0.3.44", "--iteration", "1"]);
    expect(c.directories.output).toBe("dist/rpm");
  });
  it("generates the AppImage config", () => {
    const c = buildConfig("AppImage", v) as Record<string, any>;
    expect(c.appImage.artifactName).toBe("qwen-studio-1.0.3.44-1-x86_64.AppImage");
    expect(c.directories.output).toBe("dist/appimage");
    expect(c.linux.target).toEqual(["AppImage"]);
  });
  it("does not mutate the base between calls", () => {
    buildConfig("deb", v);
    const c = buildConfig("rpm", v) as Record<string, any>;
    expect(c.deb.artifactName).toBeUndefined();
  });
  it("injects electronVersion from sidecars.json (single source of truth)", () => {
    const c = buildConfig("deb", v) as Record<string, any>;
    expect(c.electronVersion).toBe(readSidecars().electron.version);
  });
});
