import path from "node:path";

export const ROOT = process.cwd();
export const CACHE_DIR = path.join(ROOT, ".cache");
export const BUILD_DIR = path.join(ROOT, "build");
export const DIST_DIR = path.join(ROOT, "dist");
export const PATCHES_DIR = path.join(ROOT, "patches");
export const APP_DIR = path.join(BUILD_DIR, "app");
export const APP_PRISTINE_DIR = path.join(BUILD_DIR, "app-pristine");
export const WIN_APP_DIR = path.join(BUILD_DIR, "win-app");
export const NSIS_DIR = path.join(BUILD_DIR, "nsis");
export const ELECTRON_DIR = path.join(BUILD_DIR, "electron");
export const BUN_DIR = path.join(BUILD_DIR, "bun");
export const UV_DIR = path.join(BUILD_DIR, "uv");
export const UNPACKED_DIR = path.join(BUILD_DIR, "linux-unpacked");
export const ICONS_DIR = path.join(BUILD_DIR, "icons");
export const LICENSES_DIR = path.join(BUILD_DIR, "licenses");
