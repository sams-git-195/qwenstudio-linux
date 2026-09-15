import { describe, it, expect } from "vitest";
import { buildConfig, TARGETS } from "../../scripts/lib/electron-builder-config.js";
import { deriveVersions } from "../../scripts/lib/versions.js";
import { readSidecars } from "../../scripts/lib/manifest.js";

const v = deriveVersions({ version: "1.0.3", build: 44, wrapper_revision: 1 });

describe("buildConfig", () => {
  it("lists the three targets", () => expect(TARGETS).toEqual(["AppImage", "deb", "rpm"]));
  it("generates the deb config", () => {
    const c = buildConfig("deb", v) as Record<string, any>;
    expect(c.linux.target).toEqual(["deb"]);
    expect(c.directories).toEqual({ buildResources: "packaging", output: "dist/deb" });
    expect(c.extraMetadata).toEqual({ name: "qwen-studio", version: "1.0.3-44.1", description: c.linux.description, homepage: "https://github.com/sams-git-195/qwenstudio-linux" });
    expect(c.deb.artifactName).toBe("qwen-studio_1.0.3.44-1_amd64.deb");
    expect(c.deb.fpm).toEqual(["--version", "1.0.3.44", "--iteration", "1"]);
    expect(c.linux.executableArgs).toEqual(["--ozone-platform-hint=auto"]);
    expect(c.deb.depends).toContain("libasound2");
  });
  it("generates the rpm config", () => {
    const c = buildConfig("rpm", v) as Record<string, any>;
    expect(c.rpm.artifactName).toBe("qwen-studio-1.0.3.44-1.x86_64.rpm");
    expect(c.rpm.fpm).toEqual(["--version", "1.0.3.44", "--iteration", "1"]);
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
