import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand, normalizePath } from "../src/team/autoPolicy";

const ROOT = path.resolve("/ws/project");
const v = (c: string) => checkCommand(c, ROOT).verdict;

/** Task #43: input into an interpreter, sourcing, find -delete/-exec, backslash tricks. */
describe("autoPolicy: code from a pipe, stdin, source, find -exec, backslashes", () => {
  const INTERPRETERS = ["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "node", "deno", "bun", "python", "python3", "py", "perl", "ruby", "php", "lua", "osascript", "iex"];
  it.each(INTERPRETERS)("a pipe into %s asks", (i) => {
    expect(v(`cat build.js | ${i}`)).toBe("ask");
    expect(v(`echo hi | ${i}`)).toBe("ask");
    expect(v(`echo hi | ${i} -`)).toBe("ask");
  });
  it.each(INTERPRETERS)("stdin redirect into %s asks", (i) => {
    expect(v(`${i} < script.txt`)).toBe("ask");
    expect(v(`${i} - < x.py`)).toBe("ask");
  });
  it.each(["python - < x.py", "node - < x.js", "sh < script.sh", "bash < script.sh", "bash -s < x.sh", "perl - < x.pl"])("asks: %s", (c) => {
    expect(v(c)).toBe("ask");
  });
  it.each(["source ./env.sh", ". ./env.sh", "source env.sh", ". env.sh", "SOURCE x.sh", "ls; source x.sh", "ls && . ./x.sh", "bash -c 'source x.sh'"])("sourcing asks: %s", (c) => {
    expect(v(c)).toBe("ask");
  });
  it.each([
    "find . -delete",
    "find . -name '*.js' -delete",
    "find . -exec rm {} +",
    "find . -exec rm -f {} ;",
    "find . -execdir sh {} ;",
    "find . -execdir x {} +",
    "find . -name x -exec echo {} +",
    "find . -ok rm {} ;",
    "FIND . -DELETE",
  ])("find with a destructive or executing action asks: %s", (c) => {
    expect(v(c)).toBe("ask");
  });
  it("plain find stays allowed", () => {
    expect(v("find src -name '*.ts'")).toBe("allow");
    expect(v("find . -type f -name x")).toBe("allow");
  });
  it.each(["r\\m -rf build", "g\\it push", "gi\\t status", "l\\s", "n\\ode x.js", "\\rm -rf x", "ec\\ho hi"])("backslash inside a command word asks: %s", (c) => {
    expect(v(c)).toBe("ask");
  });
  // Under sh (the default off Windows) a backslash is an escape, so these only hold on Windows.
  it.runIf(process.platform === "win32")("backslashes in Windows paths and arguments are not command-word escapes", () => {
    expect(v("type src\\a.ts")).not.toBe("ask");
    expect(v("dir src\\sub")).not.toBe("ask");
    expect(v("git add src\\a.ts")).not.toBe("ask");
    expect(v("node .\\scripts\\x.js")).not.toBe("ask");
  });
  it("a pipe into a non-interpreter is fine", () => {
    expect(v("ls | grep ts")).toBe("allow");
    expect(v("cat a.txt | wc -l")).toBe("allow");
  });
  it("a program named like an interpreter but as an argument is not an interpreter", () => {
    expect(v("grep node package.json")).toBe("allow");
    expect(v("echo bash")).toBe("allow");
    expect(v("git log --grep=python")).toBe("allow");
  });
  it("interpreter with a normal script file is not refused for being an interpreter (classifier decides)", () => {
    expect(["classify", "allow"]).toContain(v("node script.js"));
    expect(["classify", "allow"]).toContain(v("python script.py"));
  });
});

/** Task #44: files created by the shell (not tracked by edit_file/write_file). Tests assume the ctx callback described there. */
describe("autoPolicy: files the shell created this session (task #44)", () => {
  const fresh = new Set<string>();
  const ctx = {
    written: new Set<string>(),
    freshFile: (abs: string) => fresh.has(normalizePath(abs)),
  } as never;
  const mark = (rel: string) => fresh.add(normalizePath(path.resolve(ROOT, rel)));
  it("an interpreter or executable naming a fresh file asks", () => {
    mark("run.js");
    mark("a.py");
    mark("a.sh");
    mark("a.bat");
    mark("tool.exe");
    for (const c of ["node run.js", "node ./run.js", "python a.py", "py a.py", "sh a.sh", "bash a.sh", "./a.sh", ".\\a.bat", "a.bat", "cmd /c a.bat", "./tool.exe", "ruby run.js", "perl run.js", "php run.js", "deno run run.js", "bun run.js"]) {
      expect(checkCommand(c, ROOT, ctx).verdict, c).toBe("ask");
    }
  });
  it("a file that is not fresh behaves as before", () => {
    expect(["classify", "allow"]).toContain(checkCommand("node old.js", ROOT, ctx).verdict);
  });
  it("applies inside package script bodies too", () => {
    mark("gen.js");
    const withScript = {
      written: new Set<string>(),
      freshFile: (abs: string) => fresh.has(normalizePath(abs)),
      scriptBody: (n: string) => (n === "gen" ? "node gen.js" : undefined),
    } as never;
    expect(checkCommand("npm run gen", ROOT, withScript).verdict).toBe("ask");
  });
  it("a throwing freshFile callback is treated as unknown, not as safe-and-fresh-free allow", () => {
    const bad = { written: new Set<string>(), freshFile: () => { throw new Error("stat failed"); } } as never;
    let r = "";
    try {
      r = checkCommand("node x.js", ROOT, bad).verdict;
    } catch {
      r = "threw";
    }
    expect(r).not.toBe("allow");
  });
});
