import { describe, it, expect } from "vitest";
import { STAGES, selectStages } from "../../scripts/build.js";

describe("build stages", () => {
  it("has the documented order", () => {
    expect(STAGES).toEqual(["fetch", "extract", "patch", "assemble", "icons"]);
  });
  it("selects a prefix with --until", () => {
    expect(selectStages("patch")).toEqual(["fetch", "extract", "patch"]);
    expect(selectStages(undefined)).toEqual(STAGES);
    expect(() => selectStages("nope")).toThrow(/Unknown stage/);
  });
});
