import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkCommand, normalizePath } from "../src/team/autoPolicy";
import type { CommandClassifier } from "../src/team/types";
import { flush, makeTeam } from "./helpers/fakeTeam";

type T = ReturnType<typeof makeTeam>;
let root: string;
let cur: T | undefined;
const pkgText = (o: Record<string, unknown>) => JSON.stringify(o, null, 2);
const BASE = { name: "x", version: "1.0.0", scripts: { test: "vitest run", build: "tsc -p ." }, dependencies: { zod: "^3.0.0" } };
const p = (rel: string) => path.join(root, rel);

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pkgrisk-")));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  cur?.team.dispose();
  cur = undefined;
});

function setup(cls?: CommandClassifier): T {
  fs.mkdirSync(p("sub"), { recursive: true });
  fs.writeFileSync(p("package.json"), pkgText(BASE));
  fs.writeFileSync(p("sub/package.json"), pkgText(BASE));
  cur = makeTeam({ defaultMode: "auto" }, { classify: cls, root });
  return cur;
}
const sig = () => new AbortController().signal;
const write = (t: T, rel: string, contents: string, id = "w1") => t.team.authorize({ id, agent: "main", tool: "write_file", input: { path: rel, contents }, absPath: p(rel) }, sig());
const edit = (t: T, rel: string, old_str: string, new_str: string, id = "e1") =>
  t.team.authorize({ id, agent: "main", tool: "edit_file", input: { path: rel, old_str, new_str }, absPath: p(rel) }, sig());
const cmd = (t: T, command: string, id = "c1") => t.team.authorize({ id, agent: "main", tool: "run_command", input: { command } }, sig());
const pending = (t: T) => t.team.approvals.pending();
const noCheck = (): CommandClassifier => vi.fn(async () => ({ verdict: "ask", reason: "classifier should not have been needed" }) as never);

describe("package.json edits in Auto mode are judged by what changes", () => {
  it("a harmless write (version, dependency) is auto-approved without asking", async () => {
    const t = setup();
    const r = await write(t, "package.json", pkgText({ ...BASE, version: "1.0.1", dependencies: { zod: "^3", lodash: "^4" } }));
    expect(r.approved).toBe(true);
    expect(r.autoApproved).toBeTruthy();
    expect(pending(t)).toEqual([]);
  });
  it("a write that changes scripts asks, naming package.json, and is not coverable", async () => {
    const t = setup();
    void write(t, "package.json", pkgText({ ...BASE, scripts: { test: "node evil.js" } }));
    await flush();
    expect(pending(t)).toHaveLength(1);
    expect(pending(t)[0].askReason).toMatch(/package\.json/);
    expect(pending(t)[0].coverable).toBe(false);
  });
  it.each(["postinstall", "prepare", "bin", "husky", "lint-staged", "config", "preinstall", "prepublishOnly"])("a write that adds %s asks", async (key) => {
    const t = setup();
    void write(t, "package.json", pkgText({ ...BASE, [key]: key === "bin" ? { x: "cli.js" } : "node evil.js" }));
    await flush();
    expect(pending(t)).toHaveLength(1);
    expect(pending(t)[0].askReason).toMatch(/package\.json/);
  });
  it("an edit_file that changes a script asks; one that bumps a dependency does not", async () => {
    const t = setup();
    void edit(t, "package.json", '"test": "vitest run"', '"test": "node evil.js"', "e1");
    await flush();
    expect(pending(t).map((r) => r.id)).toEqual(["e1"]);
    t.team.approval("e1", "reject");
    const ok = await edit(t, "package.json", '"zod": "^3.0.0"', '"zod": "^3.1.0"', "e2");
    expect(ok.approved).toBe(true);
  });
  it("an edit that cannot be analysed (old_str missing or not unique) asks", async () => {
    const t = setup();
    void edit(t, "package.json", "does-not-exist", "x", "e1");
    await flush();
    expect(pending(t)).toHaveLength(1);
    t.team.approval("e1", "reject");
    void edit(t, "package.json", '"', "'", "e2");
    await flush();
    expect(pending(t).map((r) => r.id)).toEqual(["e2"]);
  });
  it("a write of invalid JSON asks", async () => {
    const t = setup();
    void write(t, "package.json", "{ not json");
    await flush();
    expect(pending(t)).toHaveLength(1);
  });
  it("nested package.json files and case variants are judged the same way", async () => {
    const t = setup();
    void write(t, "sub/package.json", pkgText({ ...BASE, scripts: { test: "evil" } }), "w2");
    await flush();
    expect(pending(t).map((r) => r.id)).toEqual(["w2"]);
    t.team.approval("w2", "reject");
    const ok = await write(t, "sub/package.json", pkgText({ ...BASE, version: "2.0.0" }), "w3");
    expect(ok.approved).toBe(true);
  });
  it("approve-all on a risky package.json edit does not cover the next risky one", async () => {
    const t = setup();
    const a = write(t, "package.json", pkgText({ ...BASE, scripts: { test: "x" } }), "w1");
    t.team.approval("w1", "approveAll");
    await a;
    void write(t, "package.json", pkgText({ ...BASE, scripts: { test: "y" } }), "w2");
    await flush();
    expect(pending(t).map((r) => r.id)).toEqual(["w2"]);
  });
  it("in normal mode the same edits just queue as usual", async () => {
    const t = setup();
    t.team.setMode("normal");
    void write(t, "package.json", pkgText({ ...BASE, version: "9.9.9" }));
    await flush();
    expect(pending(t)).toHaveLength(1);
    expect(pending(t)[0].coverable).toBe(true);
  });
});

describe("package.json and the written-file rule", () => {
  it("after a harmless write, npm test still runs without asking or a classifier call", async () => {
    const cls = noCheck();
    const t = setup(cls);
    await write(t, "package.json", pkgText({ ...BASE, version: "1.0.1" }));
    t.team.recordWrite("main", p("package.json"));
    const r = await cmd(t, "npm test");
    expect(r.approved).toBe(true);
    expect(cls).not.toHaveBeenCalled();
    expect(pending(t)).toEqual([]);
  });
  it("after a risky, approved write, npm test asks (the script body may have changed)", async () => {
    const t = setup();
    const w = write(t, "package.json", pkgText({ ...BASE, scripts: { test: "node evil.js" } }));
    await flush();
    t.team.approval("w1", "approve");
    await w;
    t.team.recordWrite("main", p("package.json"));
    void cmd(t, "npm test", "c1");
    await flush();
    expect(pending(t).map((r) => r.id)).toEqual(["c1"]);
    expect(pending(t)[0].askReason).toMatch(/package\.json/);
  });
  it("a risky edit that is rejected leaves npm test allowed", async () => {
    const cls = noCheck();
    const t = setup(cls);
    const w = write(t, "package.json", pkgText({ ...BASE, scripts: { test: "evil" } }));
    await flush();
    t.team.approval("w1", "reject");
    await w;
    const r = await cmd(t, "npm test");
    expect(r.approved).toBe(true);
  });
  it("scripts are read from the real package.json in the workspace", async () => {
    const cls = noCheck();
    const t = setup(cls);
    expect((await cmd(t, "npm run build")).approved).toBe(true);
    expect(cls).not.toHaveBeenCalled();
    void cmd(t, "npm run nope", "c2"); // unknown script: not allowlisted, so it does not run silently
    await flush();
    expect(pending(t).map((r) => r.id)).toEqual(["c2"]);
  });
});

describe("policy: script bodies, --prefix, cd, existing files", () => {
  const ROOT = path.resolve("/ws/proj");
  const ctxFor = (dirScripts: Record<string, Record<string, string>>, extra = {}) => ({
    written: new Set<string>(),
    scriptBody: (name: string, dir?: string) => dirScripts[normalizePath(dir ?? "")]?.[name] ?? dirScripts[""]?.[name],
    ...extra,
  });
  it("a script whose body is itself allowed is allowed, whatever its name", () => {
    const ctx = ctxFor({ "": { typecheck: "tsc --noEmit", check: "tsc && vitest run", gen: "node gen.js", ship: "npm publish" } });
    expect(checkCommand("npm run typecheck", ROOT, ctx).verdict).toBe("allow");
    expect(checkCommand("npm run check", ROOT, ctx).verdict).toBe("allow");
    expect(checkCommand("npm run gen", ROOT, ctx).verdict).toBe("classify");
    expect(checkCommand("npm run ship", ROOT, ctx).verdict).toBe("ask");
  });
  it("cd into a workspace folder then a command is judged relative to that folder; leaving the workspace asks", () => {
    const ctx = ctxFor({ "": { build: "tsc" } });
    expect(checkCommand("cd sub && npm test", ROOT, ctx).verdict).not.toBe("ask");
    expect(checkCommand("cd .. && ls", ROOT, ctx).verdict).toBe("ask");
    expect(checkCommand("cd /etc && ls", ROOT, ctx).verdict).toBe("ask");
  });
});

describe("build tools and runners (allow) versus watch/dev/publish (classify)", () => {
  const ROOT2 = path.resolve("/ws/proj");
  const v = (c: string) => checkCommand(c, ROOT2, { written: new Set() }).verdict;
  it.each([
    "npx vite build", "vite build", "tsc", "esbuild src/index.ts --bundle --outfile=out.js", "npx rollup -c", "npx webpack", "npx tsup", "npx next build", "npx next lint", "npx astro build",
    "npx astro check", "npx svelte-kit sync", "npx jest", "jest --ci", "npx mocha", "ruff check .", "mypy src", "black --check .", "gradle test", "./gradlew build", "gradlew.bat check", "mvn test",
    "mvn verify", "./mvnw package", "Select-String foo src\\a.ts", "sls foo src\\a.ts",
  ])("allow: %s", (c) => expect(v(c), c).toBe("allow"));
  it.each(["npx vite build --watch", "npx tsc --watch", "tsc -w"])("long-running watch flags must not be allowed outright (GAP): %s", (c) => expect(v(c), c).not.toBe("allow"));
  it.each(["npx vite", "vite dev", "vite --host", "npx jest --watch", "npx next dev", "npx webpack serve", "npx astro dev", "mvn deploy", "mvn install", "mvn release:prepare", "black .", "npm run dev", "npm start", "npx serve"])(
    "not allowed outright: %s",
    (c) => expect(v(c), c).not.toBe("allow"),
  );
  it("git restore --staged <path> is allowed, but not '.' or --source", () => {
    expect(v("git restore --staged src/a.ts")).toBe("allow");
    expect(["ask", "classify"]).toContain(v("git restore --staged ."));
    expect(["ask", "classify"]).toContain(v("git restore --source=HEAD~3 src/a.ts"));
  });
  it("mkdir / New-Item directory inside the workspace is allowed; outside asks", () => {
    expect(v("mkdir out")).toBe("allow");
    expect(v("md out")).toBe("allow");
    expect(v("New-Item -ItemType Directory out")).toBe("allow");
    expect(v("mkdir ../out")).toBe("ask");
    expect(v("mkdir /tmp/out")).toBe("ask");
    expect(v("mkdir ~/out")).toBe("ask");
  });
  it("git stash, branch <name>, checkout -b, switch, fetch are allowed; reset/clean/push are not", () => {
    for (const c of ["git stash", "git stash pop", "git stash list", "git stash apply", "git branch topic", "git checkout -b topic", "git switch main", "git switch -c topic", "git fetch"]) expect(v(c), c).toBe("allow");
    for (const c of ["git reset --hard", "git clean -fd", "git push", "git stash drop --all".replace(" --all", "") + " ; git push"]) expect(v(c), c).toBe("ask");
  });
});
