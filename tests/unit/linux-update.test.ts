import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const mod = require("../../src/app/linux-update.js");
const yamlText = readFileSync("tests/fixtures/latest-linux.yml", "utf8");

type ShowMessageBoxOptions = {
  type?: string;
  icon?: string;
  title?: string;
  message: string;
  buttons?: string[];
};

function deps(response = 0, text = yamlText, fail = false) {
  const dialog = {
    showMessageBox: vi.fn<(opts: ShowMessageBoxOptions) => Promise<{ response: number }>>(async () => ({ response })),
  };
  const shell = { openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}) };
  const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    if (fail) throw new Error("boom");
    return new Response(text, { status: 200 });
  });
  const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? ":" + JSON.stringify(o) : ""}`;
  return { dialog, shell, fetchImpl, t, icon: "/tmp/icon.png" };
}

const origPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: origPlatform });
  delete process.env.APPIMAGE;
});

describe("isNotifyOnly", () => {
  it("is true on linux without APPIMAGE", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(mod.isNotifyOnly()).toBe(true);
  });
  it("is false on linux with APPIMAGE", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.APPIMAGE = "/tmp/x.AppImage";
    expect(mod.isNotifyOnly()).toBe(false);
  });
  it("is false on other platforms", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(mod.isNotifyOnly()).toBe(false);
  });
});

describe("parseLatestYaml / compare", () => {
  it("parses the version line", () => expect(mod.parseLatestYaml(yamlText)).toEqual({ version: "1.0.3-44.2" }));
  it("throws without a version line", () => expect(() => mod.parseLatestYaml("files: []")).toThrow(/no version/));
  it("compares with semver", () => {
    expect(mod.compare("1.0.3-44.1", "1.0.3-44.2")).toBe("newer");
    expect(mod.compare("1.0.3-44.2", "1.0.3-44.2")).toBe("same");
    expect(mod.compare("1.0.3-45.1", "1.0.3-44.2")).toBe("older");
  });
});

describe("check", () => {
  it("shows the dialog and opens the releases page when newer", async () => {
    const d = deps(0);
    await mod.check({ manual: false, currentVersion: "1.0.3-44.1", ...d });
    expect(d.fetchImpl).toHaveBeenCalledWith(mod.FEED_URL, expect.objectContaining({ headers: expect.objectContaining({ "Cache-Control": "no-cache" }) }));
    expect(d.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(d.dialog.showMessageBox.mock.calls[0][0].buttons).toEqual(["update.download_now", "update.later"]);
    expect(d.shell.openExternal).toHaveBeenCalledWith(mod.RELEASES_URL);
  });
  it("does not open the page when the user picks Later", async () => {
    const d = deps(1);
    await mod.check({ manual: false, currentVersion: "1.0.3-44.1", ...d });
    expect(d.shell.openExternal).not.toHaveBeenCalled();
  });
  it("shows 'latest version' only for manual checks", async () => {
    const auto = deps(0);
    await mod.check({ manual: false, currentVersion: "1.0.3-44.2", ...auto });
    expect(auto.dialog.showMessageBox).not.toHaveBeenCalled();
    const manual = deps(0);
    await mod.check({ manual: true, currentVersion: "1.0.3-44.2", ...manual });
    expect(manual.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(manual.dialog.showMessageBox.mock.calls[0][0].message).toBe('update.latest_version:{"version":"1.0.3-44.2"}');
  });
  it("swallows fetch errors (dialog only when manual)", async () => {
    const auto = deps(0, yamlText, true);
    await expect(mod.check({ manual: false, currentVersion: "1.0.3-44.1", ...auto })).resolves.toBeUndefined();
    expect(auto.dialog.showMessageBox).not.toHaveBeenCalled();
    const manual = deps(0, yamlText, true);
    await mod.check({ manual: true, currentVersion: "1.0.3-44.1", ...manual });
    expect(manual.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
