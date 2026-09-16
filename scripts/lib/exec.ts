import { spawnSync } from "node:child_process";

export interface RunOpts { cwd?: string; capture?: boolean; env?: NodeJS.ProcessEnv; allowFailure?: boolean }

export function run(cmd: string, args: string[], opts: RunOpts = {}): string {
  // shell: false is the Node default, but stated explicitly: args are passed to the
  // executable verbatim (paths with spaces such as "/opt/Qwen Studio" and any
  // metacharacters are never interpreted by a shell). CodeQL's
  // js/shell-command-injection-from-environment relies on this being static.
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}: ${(r.stderr ?? "").toString().trim()}`);
  }
  return (r.stdout ?? "").toString();
}
