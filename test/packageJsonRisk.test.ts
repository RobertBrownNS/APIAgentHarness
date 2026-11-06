import { describe, expect, it } from "vitest";
import { packageJsonRisk } from "../src/team/autoPolicy";

const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2);
const base = { name: "x", version: "1.0.0", scripts: { test: "vitest run" }, dependencies: { zod: "^3.0.0" } };

describe("packageJsonRisk", () => {
  it("harmless changes are not risky", () => {
    for (const next of [
      { ...base, version: "1.0.1" },
      { ...base, description: "new" },
      { ...base, dependencies: { zod: "^3.0.0", lodash: "^4.0.0" } },
      { ...base, devDependencies: { vitest: "^3" } },
      { ...base, name: "y" },
      { ...base, keywords: ["a"], license: "MIT" },
    ]) {
      expect(packageJsonRisk(pkg(base), pkg(next)), JSON.stringify(next)).toBeUndefined();
    }
  });
  it("no change at all is not risky", () => {
    expect(packageJsonRisk(pkg(base), pkg(base))).toBeUndefined();
  });
  it("changing, adding or removing scripts is risky", () => {
    expect(packageJsonRisk(pkg(base), pkg({ ...base, scripts: { test: "node evil.js" } }))).toMatch(/scripts/);
    expect(packageJsonRisk(pkg(base), pkg({ ...base, scripts: { ...base.scripts, extra: "x" } }))).toMatch(/scripts/);
    expect(packageJsonRisk(pkg(base), pkg({ ...base, scripts: {} }))).toMatch(/scripts/);
    const { scripts: _s, ...noScripts } = base;
    expect(packageJsonRisk(pkg(base), pkg(noScripts))).toMatch(/scripts/);
  });
  it.each(["bin", "husky", "lint-staged", "simple-git-hooks", "config", "prepare", "prepack", "postinstall", "preinstall", "install", "prepublishOnly", "postpublish", "preversion", "pretest", "postbuild"])(
    "touching %s is risky",
    (k) => {
      expect(packageJsonRisk(pkg(base), pkg({ ...base, [k]: "x" })), k).toMatch(new RegExp(k));
    },
  );
  it("case variants of pre/post hook keys are covered", () => {
    expect(packageJsonRisk(pkg(base), pkg({ ...base, PostInstall: "x" }))).toBeDefined();
    expect(packageJsonRisk(pkg(base), pkg({ ...base, PREPARE: "x" }))).toBeDefined();
  });
  it("an unchanged risky field is fine (only changes count)", () => {
    const withBin = { ...base, bin: { x: "cli.js" }, husky: { hooks: {} } };
    expect(packageJsonRisk(pkg(withBin), pkg({ ...withBin, version: "2.0.0" }))).toBeUndefined();
  });
  it("key order inside scripts does not matter only if values are equal (reordering counts as a change here, but must not crash)", () => {
    const a = { ...base, scripts: { a: "1", b: "2" } };
    const b = { ...base, scripts: { b: "2", a: "1" } };
    expect(() => packageJsonRisk(pkg(a), pkg(b))).not.toThrow();
  });
  it("invalid JSON in the result or the current file is risky, never harmless", () => {
    expect(packageJsonRisk(pkg(base), "{ nope")).toMatch(/not valid JSON/);
    expect(packageJsonRisk("{ nope", pkg(base))).toMatch(/not valid JSON/);
    expect(packageJsonRisk(pkg(base), "")).toBeDefined();
  });
  it("unexpected top-level structure is risky", () => {
    expect(packageJsonRisk(pkg(base), "[]")).toBeDefined();
    expect(packageJsonRisk(pkg(base), "null")).toBeDefined();
    expect(packageJsonRisk(pkg(base), '"str"')).toBeDefined();
    expect(packageJsonRisk("[]", pkg(base))).toBeDefined();
  });
  it("a brand new package.json (no old content) is judged by its own fields", () => {
    expect(packageJsonRisk(undefined, pkg({ name: "x", version: "1.0.0" }))).toBeUndefined();
    expect(packageJsonRisk(undefined, pkg({ name: "x", scripts: { test: "x" } }))).toMatch(/scripts/);
    expect(packageJsonRisk(undefined, pkg({ name: "x", postinstall: "x" }))).toBeDefined();
  });
  it("prototype-pollution style keys do not crash or hide a change", () => {
    const evil = '{"name":"x","__proto__":{"scripts":{"test":"evil"}},"scripts":{"test":"vitest run"}}';
    expect(() => packageJsonRisk(pkg(base), evil)).not.toThrow();
  });
  it("whitespace-only reformatting is not a change", () => {
    expect(packageJsonRisk(JSON.stringify(base), JSON.stringify(base, null, 4))).toBeUndefined();
  });
});
