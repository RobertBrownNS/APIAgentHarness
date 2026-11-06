import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isSensitivePath } from "../src/team/autoPolicy";

/** Where the workspace itself lives must not make every file in it look sensitive. */
describe("isSensitivePath only judges the part inside the workspace", () => {
  const roots = [
    path.resolve("C:/Users/RUNNER~1/AppData/Local/Temp/proj"), // 8.3 short-name segment (GitHub's Windows runner)
    path.resolve("/home/me/.vscode/extensions/proj"), // a project kept under a dot-folder
    path.resolve("/srv/.git-mirror/.git/proj"),
  ];
  it.each(roots)("ordinary files under %s are not sensitive", (root) => {
    expect(isSensitivePath(path.join(root, "src", "a.ts"), root)).toBe(false);
    expect(isSensitivePath(path.join(root, "README.md"), root)).toBe(false);
  });
  it.each(roots)("sensitive files under %s still are", (root) => {
    expect(isSensitivePath(path.join(root, ".env"), root)).toBe(true);
    expect(isSensitivePath(path.join(root, ".git", "config"), root)).toBe(true);
    expect(isSensitivePath(path.join(root, "PACKAG~1.JSO"), root)).toBe(true); // short name inside the workspace
  });
  it("a path outside the workspace is judged in full", () => {
    const root = path.resolve("/work/proj");
    expect(isSensitivePath(path.resolve("/home/me/.ssh/id_rsa"), root)).toBe(true);
  });
});
