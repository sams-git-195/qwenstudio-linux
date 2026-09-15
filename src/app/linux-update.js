"use strict";
// Notify-only update check for deb/rpm installs of Qwen Studio on Linux.
// Shipped inside app.asar as out/main/linux-update.js; required by patches/0002-linux-updater.patch.
// No Electron import at module level so the module is unit-testable in plain Node.
const semver = require("semver");

const FEED_URL = "https://github.com/sams-git-195/qwenstudio-linux/releases/latest/download/latest-linux.yml";
const RELEASES_URL = "https://github.com/sams-git-195/qwenstudio-linux/releases/latest";
const TIMEOUT_MS = 15000;

function isNotifyOnly() {
  return process.platform === "linux" && !process.env.APPIMAGE;
}

function parseLatestYaml(text) {
  const m = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(String(text));
  if (!m) throw new Error("latest-linux.yml: no version line");
  return { version: m[1] };
}

function compare(current, latest) {
  if (semver.gt(latest, current)) return "newer";
  if (semver.eq(latest, current)) return "same";
  return "older";
}

async function fetchText(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { "Cache-Control": "no-cache", Accept: "text/plain, */*" }, redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function showLatest({ dialog, icon, t, currentVersion }) {
  await dialog.showMessageBox({ type: "info", icon, message: t("update.latest_version", { version: currentVersion }) });
}

async function check({ manual, currentVersion, dialog, shell, net, t, icon, fetchImpl }) {
  const f = fetchImpl || (net && typeof net.fetch === "function" ? net.fetch.bind(net) : globalThis.fetch);
  try {
    const { version } = parseLatestYaml(await fetchText(FEED_URL, f));
    if (compare(currentVersion, version) === "newer") {
      console.log(`[linux-update] update available ${version}`);
      const { response } = await dialog.showMessageBox({
        type: "info",
        icon,
        title: t("update.new_version_found"),
        message: t("update.new_version_message", { version }),
        buttons: [t("update.download_now"), t("update.later")],
      });
      if (response === 0) await shell.openExternal(RELEASES_URL);
    } else {
      console.log(`[linux-update] up to date ${currentVersion}`);
      if (manual) await showLatest({ dialog, icon, t, currentVersion });
    }
  } catch (err) {
    console.error("[linux-update]", err && err.message ? err.message : err);
    if (manual) {
      try {
        await showLatest({ dialog, icon, t, currentVersion });
      } catch (e) {
        console.error("[linux-update]", e);
      }
    }
  }
}

module.exports = { isNotifyOnly, parseLatestYaml, compare, check, FEED_URL, RELEASES_URL };
