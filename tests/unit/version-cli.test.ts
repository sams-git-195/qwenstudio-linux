import { describe, it, expect } from "vitest";
import { resolvePrintField } from "../../scripts/version.js";
import { deriveVersions } from "../../scripts/lib/versions.js";

const v = deriveVersions({ version: "1.0.3", build: 44, wrapper_revision: 1 });

describe("resolvePrintField", () => {
  it("returns a top-level field", () => {
    expect(resolvePrintField(v, "gitTag")).toBe("v1.0.3.44-1");
  });
  it("returns a dotted artifacts.<name> field", () => {
    expect(resolvePrintField(v, "artifacts.deb")).toBe("qwen-studio_1.0.3.44-1_amd64.deb");
  });
  it("throws a usage error when no field is given", () => {
    expect(() => resolvePrintField(v, undefined)).toThrow("Usage: version --print <field>");
  });
  it("throws an unknown-field error for a bogus field", () => {
    expect(() => resolvePrintField(v, "nope")).toThrow("Unknown field: nope");
  });
  it("throws an unknown-field error for an object-valued field", () => {
    expect(() => resolvePrintField(v, "artifacts")).toThrow("Unknown field: artifacts");
  });
});
