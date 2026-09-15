import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readUpstream } from "./lib/manifest.js";
import { deriveVersions, type DerivedVersions } from "./lib/versions.js";
import { BUILD_DIR } from "./lib/paths.js";

export function writeVersionJson(): DerivedVersions {
  const v = deriveVersions(readUpstream());
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(path.join(BUILD_DIR, "version.json"), JSON.stringify(v, null, 2) + "\n");
  return v;
}

export function main(argv = process.argv.slice(2)): void {
  const v = writeVersionJson();
  const i = argv.indexOf("--print");
  if (i !== -1) {
    const field = argv[i + 1];
    const value = field.startsWith("artifacts.")
      ? v.artifacts[field.slice("artifacts.".length) as keyof DerivedVersions["artifacts"]]
      : (v as unknown as Record<string, unknown>)[field];
    if (value === undefined || typeof value === "object") { console.error(`Unknown field: ${field}`); process.exit(1); }
    process.stdout.write(String(value) + "\n");
    return;
  }
  if (argv.includes("--json")) { process.stdout.write(JSON.stringify(v, null, 2) + "\n"); return; }
  for (const [k, val] of Object.entries(v)) {
    console.log(typeof val === "object" ? `${k}: ${JSON.stringify(val)}` : `${k}: ${val}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
