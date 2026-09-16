import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { ICONS_DIR, WIN_APP_DIR } from "./lib/paths.js";

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

export async function renderIcons(src: string, outDir: string): Promise<number[]> {
  const meta = await sharp(src).metadata();
  if (!meta.width || !meta.height || meta.width !== meta.height) {
    throw new Error(`icon source must be square, got ${meta.width}x${meta.height}`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const n of ICON_SIZES) {
    await sharp(src)
      .resize(n, n, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(outDir, `${n}x${n}.png`));
  }
  return ICON_SIZES;
}

export async function main(): Promise<void> {
  const sizes = await renderIcons(path.join(WIN_APP_DIR, "resources", "assets", "icon.png"), ICONS_DIR);
  console.log(`rendered icons: ${sizes.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
