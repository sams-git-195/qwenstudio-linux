import { describe, it, expect } from "vitest";
import os from "node:os";
import semver from "semver";
import { AppImageUpdater } from "electron-updater";
import { deriveVersions } from "../../scripts/lib/versions.js";

function fakeUpdater(version: string) {
  return new AppImageUpdater(
    { provider: "github", owner: "sams-git-195", repo: "qwenstudio-linux" },
    {
      version, name: "qwen-studio", isPackaged: true, appUpdateConfigPath: "/nonexistent/app-update.yml",
      userDataPath: os.tmpdir(), baseCachePath: os.tmpdir(),
      whenReady: async () => {}, quit() {}, relaunch() {}, onQuit() {},
    } as never,
  );
}
const info = (version: string) => ({ version, files: [], path: "", sha512: "", releaseDate: "" });

describe("deriveVersions", () => {
  it("derives every field for 1.0.3 build 44 rev 1", () => {
    expect(deriveVersions({ version: "1.0.3", build: 44, wrapper_revision: 1 })).toEqual({
      appVersion: "1.0.3-44.1",
      upstreamLabel: "1.0.3.44",
      debVersion: "1.0.3.44-1",
      rpmVersion: "1.0.3.44",
      rpmRelease: "1",
      gitTag: "v1.0.3.44-1",
      releaseName: "Qwen Studio 1.0.3.44 (linux-1)",
      artifacts: {
        deb: "qwen-studio_1.0.3.44-1_amd64.deb",
        rpm: "qwen-studio-1.0.3.44-1.x86_64.rpm",
        appImage: "qwen-studio-1.0.3.44-1-x86_64.AppImage",
      },
    });
  });
  it("derives every field for 1.0.4 build 1 rev 1", () => {
    const v = deriveVersions({ version: "1.0.4", build: 1, wrapper_revision: 1 });
    expect(v.appVersion).toBe("1.0.4-1.1");
    expect(v.debVersion).toBe("1.0.4.1-1");
    expect(v.gitTag).toBe("v1.0.4.1-1");
    expect(v.artifacts.appImage).toBe("qwen-studio-1.0.4.1-1-x86_64.AppImage");
  });
  it("orders releases with electron-updater's own comparator", async () => {
    const chain = ["1.0.3-44.1", "1.0.3-44.2", "1.0.3-44.10", "1.0.3-45.1", "1.0.4-1.1"];
    for (let i = 0; i < chain.length; i++) {
      const u = fakeUpdater(chain[i]);
      const cmp = u as unknown as { isUpdateAvailable(info: { version: string }): Promise<boolean> };
      for (let j = 0; j < chain.length; j++) {
        expect(await cmp.isUpdateAvailable(info(chain[j])), `${chain[j]} vs current ${chain[i]}`).toBe(j > i);
      }
    }
  });
  it("documents that allowPrerelease defaults to true for our versions (patch 0002 sets it false)", () => {
    expect(fakeUpdater("1.0.3-44.1").allowPrerelease).toBe(true);
  });
  it("documents that tags are not semver and app versions are", () => {
    expect(semver.valid("1.0.3-44.1")).toBe("1.0.3-44.1");
    expect(semver.valid("1.0.3.44-1")).toBeNull();
  });
});
