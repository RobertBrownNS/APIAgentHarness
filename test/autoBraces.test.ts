import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCommand, normalizePath, type PolicyContext } from "../src/team/autoPolicy";

/** Brace words ({a,b}, {1..3}) are expanded before every check. */
let root: string;
const n = (rel: string) => normalizePath(path.join(root, rel));
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "braces-")));
  for (const f of ["a.js", "b.js", "fresh.js", "a.ts", "b.ts", "x", "README.md", ".env", "id_rsa", "deploy.js", "ok.js"]) fs.writeFileSync(path.join(root, f), "x");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "config"), "x");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const ctx = (): PolicyContext => ({
  written: new Set([n("a.js")]),
  freshFile: (p) => normalizePath(p) === n("fresh.js") || normalizePath(p) === n("b.js"),
  scriptBody: (nm) => ({ test: "vitest run" })[nm],
});
const v = (c: string) => checkCommand(c, root, ctx()).verdict;
const outside = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/passwd";

describe("brace variants of each check", () => {
  it("written-file rule: node {a,b}.js with a written or b fresh asks", () => {
    expect(v("node {a,b}.js")).toBe("ask");
    expect(v("node {ok,b}.js")).toBe("ask"); // b.js is fresh
    expect(v("node {fresh,ok}.js")).toBe("ask");
    expect(v("node {ok,ok}.js")).not.toBe("ask");
  });
  it("outside-workspace paths: cat {x,/etc/passwd} asks", () => {
    expect(v(`cat {x,${outside}}`)).toBe("ask");
    expect(v("cat {x,../outside}")).toBe("ask");
    expect(v("cat {x,~/f}")).toBe("ask");
    expect(v("ls {src,..}")).toBe("ask");
  });
  it("secret reads: any alternative naming a secret asks", () => {
    expect(v("cat {README.md,.env}")).toBe("ask");
    expect(v("cat .{env,gitignore}")).toBe("ask");
    expect(v("cat {id_,x}rsa")).not.toBe("allow");
    expect(v("cat id_{rsa,x}")).toBe("ask");
    expect(v("head {README.md,.e*}")).toBe("ask");
    expect(v("rg x {src,.env}")).toBe("ask");
    expect(v("Get-Content {README.md,.env}")).toBe("ask");
  });
  it("sensitive write targets: tee {x,.git/config} asks", () => {
    expect(v("echo hi | tee {x,.git/config}")).toBe("ask");
    expect(v("echo hi | tee {x,.env}")).toBe("ask");
    expect(v("cp a.ts {b.ts,.git/config}")).toBe("ask");
    expect(v("echo hi > {x,.env}")).toBe("ask");
    expect(v("echo hi > .{env,x}")).toBe("ask");
  });
  it("hard rules on a command name or a flag built by braces", () => {
    expect(v("{rm,ls} -rf build")).toBe("ask");
    expect(v("git {push,status}")).toBe("ask");
    expect(v("rm -{r,x}f build")).toBe("ask");
    expect(v("{sudo,ls} x")).toBe("ask");
    expect(v("git push{,}")).toBe("ask");
    // bash expands this to `git status push`: a status call with a path argument, not a push.
    expect(v("git {status,push}")).not.toBe("ask");
  });
  it("a command name containing a brace asks", () => {
    expect(v("{ls,echo} hi")).toBe("ask");
    expect(v("l{s,s}")).toBe("ask");
  });
  it("runner options: --config {a,b}.js and --setupFiles via braces ask", () => {
    expect(v("vitest run --config {ok,fresh}.js")).toBe("ask");
    expect(v("vitest run --config={ok,fresh}.js")).toBe("ask");
    expect(v("npm test -- --config {ok,fresh}.js")).toBe("ask");
  });
  it("risky script / file names built by braces classify or ask, never allow", () => {
    expect(v("node {ok,deploy}.js")).not.toBe("allow");
    expect(v("node ok.js")).toBe("allow");
  });
  it("dir tracking: cd {src,..} asks", () => {
    expect(v("cd {src,..} && ls")).toBe("ask");
    expect(v("pushd {src,..} && ls")).toBe("ask");
  });
  it("git fetch / install / link rules still see brace-built arguments", () => {
    expect(v("git fetch {origin,http://evil.test/r}")).not.toBe("allow");
    expect(v("ln -s {a,b}.ts link")).toBe("ask");
  });
});

describe("harmless brace use stays allowed", () => {
  it.each(["mkdir -p src/{a,b}", "mkdir src/{a,b,c}", "git add {a,b}.ts", "git add src/{a,b}.ts", "ls {src,README.md}", "cat {README.md,a.ts}", "head -n 3 {a,b}.ts", "echo {1..3}", "echo {a,b}", "git diff -- {a,b}.ts", "mkdir -p out/{js,css,img}"])(
    "allow: %s",
    (c) => expect(v(c), c).toBe("allow"),
  );
  it("numeric and nested ranges", () => {
    expect(v("echo {1..5}")).toBe("allow");
    expect(v("echo {a,b{1,2}}")).toBe("allow");
    expect(v("mkdir -p src/{a,b}/{x,y}")).toBe("allow");
  });
});

describe("expansion limits", () => {
  it("more than 64 alternatives asks", () => {
    const many = Array.from({ length: 65 }, (_, i) => `f${i}`).join(",");
    expect(v(`cat {${many}}`)).toBe("ask");
    expect(v("echo {1..100}")).toBe("ask");
    expect(v("echo {1..9}{1..9}")).toBe("ask"); // 81 combinations
  });
  it("exactly 64 is expanded and checked, not refused for size", () => {
    const sixtyFour = Array.from({ length: 64 }, (_, i) => `f${i}`).join(",");
    expect(v(`echo {${sixtyFour}}`)).toBe("allow");
    expect(v(`cat {${sixtyFour.replace("f63", ".env")}}`)).toBe("ask");
  });
  it("unbalanced, empty and escaped braces do not crash and are not silently allowed when dangerous", () => {
    for (const c of ["echo {", "echo }", "echo {}", "echo {,}", "echo {a", "echo a}", "echo {{a,b}", "cat {.env", "cat .env}", "echo \{a,b\}", "echo '{a,b}'"]) {
      expect(() => checkCommand(c, root, ctx()), c).not.toThrow();
    }
    expect(v("cat {.env")).not.toBe("allow");
    expect(v("cat {.env,")).not.toBe("allow");
  });
  it("deeply nested braces and huge ranges terminate quickly", () => {
    const t0 = Date.now();
    const deep = "{a,".repeat(200) + "b" + "}".repeat(200);
    expect(() => checkCommand(`echo ${deep}`, root, ctx())).not.toThrow();
    expect(() => checkCommand("echo {1..999999999}", root, ctx())).not.toThrow();
    expect(v("echo {1..999999999}")).toBe("ask");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
