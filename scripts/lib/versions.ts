import type { UpstreamManifest } from "./manifest.js";

export interface DerivedVersions {
  appVersion: string;
  upstreamLabel: string;
  debVersion: string;
  rpmVersion: string;
  rpmRelease: string;
  gitTag: string;
  releaseName: string;
  artifacts: { deb: string; rpm: string; appImage: string };
}

export function deriveVersions(u: Pick<UpstreamManifest, "version" | "build" | "wrapper_revision">): DerivedVersions {
  const upstreamLabel = `${u.version}.${u.build}`;
  const rev = String(u.wrapper_revision);
  const pkgVersion = `${upstreamLabel}-${rev}`;
  return {
    appVersion: `${u.version}-${u.build}.${rev}`,
    upstreamLabel,
    debVersion: pkgVersion,
    rpmVersion: upstreamLabel,
    rpmRelease: rev,
    gitTag: `v${pkgVersion}`,
    releaseName: `Qwen Studio ${upstreamLabel} (linux-${rev})`,
    artifacts: {
      deb: `qwen-studio_${pkgVersion}_amd64.deb`,
      rpm: `qwen-studio-${pkgVersion}.x86_64.rpm`,
      appImage: `qwen-studio-${pkgVersion}-x86_64.AppImage`,
    },
  };
}
