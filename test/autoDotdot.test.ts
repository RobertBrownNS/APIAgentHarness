import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCommand, type PolicyContext } from "../src/team/autoPolicy";

/** `..` only asks when the resolved path actually leaves the workspace. */
let root: string;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dotdot-")));
  for (const d of ["src", "test", "webview-ui/src"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ["src/a.ts", "test/a.test.ts", "webview-ui/src/App.tsx", "README.md", "tsconfig.json"]) {
    fs.writeFileSync(path.join(root, f), "x");
  }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const ctx = (): PolicyContext => ({ written: new Set(), freshFile: () => false });
const v = (c: string) => checkCommand(c, root, ctx()).verdict;

describe(".. paths that stay inside the workspace", () => {
  it.each([
    "cat src/../README.md",
    "ls src/..",
    "mkdir -p src/../lib",
    "cd webview-ui && cat ../README.md",
    "cd webview-ui && npx tsc -p ../tsconfig.json",
    "cd webview-ui/src && ls ../..",
    ...(process.platform === "win32" ? ["cd webview-ui/src && cat ..\\..\\README.md"] : []), // backslash paths: Windows only
    "cd webview-ui && cd ..",
    "npx tsc --project=src/../tsconfig.json",
  ])("%s is not refused for leaving the workspace", (c) => {
    expect(v(c)).not.toBe("ask");
  });
});

describe(".. paths that really leave the workspace", () => {
  it.each([
    "ls ../",
    "cat ..\\README.md",
    "cat ../../etc/passwd",
    "cd .. && ls",
    "cd webview-ui/src && ls ../../..",
    "cp src/a.ts ../outside.ts",
    "npx tsc --project=../tsconfig.json",
    "cat src/../../x",
  ])("%s asks", (c) => {
    expect(v(c)).toBe("ask");
  });
});
