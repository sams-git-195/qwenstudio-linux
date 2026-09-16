import { describe, it, expect } from "vitest";
import { run } from "../../scripts/lib/exec.js";

describe("run", () => {
  it("passes arguments verbatim without shell interpretation", () => {
    const tricky = "/opt/Qwen Studio/$HOME;`id` && echo *";
    const out = run("printf", ["%s", tricky], { capture: true });
    expect(out).toBe(tricky);
  });

  it("returns stdout when capture is set", () => {
    expect(run("echo", ["hello"], { capture: true })).toBe("hello\n");
  });

  it("throws with the command, args, status and stderr on non-zero exit", () => {
    expect(() => run("sh", ["-c", "echo boom >&2; exit 3"], { capture: true })).toThrow(
      /^sh -c echo boom >&2; exit 3 exited with 3: boom$/,
    );
  });

  it("does not throw on non-zero exit when allowFailure is set", () => {
    expect(() => run("false", [], { capture: true, allowFailure: true })).not.toThrow();
  });

  it("throws when the executable does not exist", () => {
    expect(() => run("definitely-not-a-real-binary-xyz", [], { capture: true })).toThrow(/ENOENT/);
  });
});
