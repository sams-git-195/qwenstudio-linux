import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeVersionJson } from "./version.js";
import { fetchAll } from "./fetch.js";
import { extractAll } from "./extract.js";
import { applyPatches, finishPatchStage } from "./patch.js";
import { assemble } from "./assemble.js";
import { renderIcons } from "./icons.js";
import { ICONS_DIR, WIN_APP_DIR } from "./lib/paths.js";

export const STAGES = ["fetch", "extract", "patch", "assemble", "icons"] as const;
export type Stage = (typeof STAGES)[number];

export function selectStages(until: string | undefined): Stage[] {
  if (until === undefined) return [...STAGES];
  const i = STAGES.indexOf(until as Stage);
  if (i === -1) throw new Error(`Unknown stage "${until}"; expected one of ${STAGES.join(", ")}`);
  return STAGES.slice(0, i + 1) as Stage[];
}

const impl: Record<Stage, () => Promise<void>> = {
  fetch: async () => { await fetchAll(); },
  extract: extractAll,
  patch: async () => { applyPatches(); finishPatchStage(); },
  assemble,
  icons: async () => { await renderIcons(path.join(WIN_APP_DIR, "resources", "assets", "icon.png"), ICONS_DIR); },
};

export async function runStages(until?: string): Promise<void> {
  const v = writeVersionJson();
  console.log(`== building Qwen Studio ${v.appVersion} (tag ${v.gitTag})`);
  for (const s of selectStages(until)) {
    const t0 = Date.now();
    console.log(`== stage: ${s}`);
    await impl[s]();
    console.log(`== stage ${s} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const i = argv.indexOf("--until");
  await runStages(i === -1 ? undefined : argv[i + 1]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
