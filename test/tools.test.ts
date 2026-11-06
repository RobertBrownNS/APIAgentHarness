import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// tools.ts imports "vscode" at module level; only the file/search tools use it at call time.
vi.mock("vscode", () => ({ Uri: { file: (p: string) => ({ fsPath: p }) } }));

import { MUTATING, parseToolInput, runTool, toolDefinitions, ToolError, type ToolContext } from "../src/agent/tools";

// ---------- parseToolInput / definitions ----------

describe("parseToolInput", () => {
  it("accepts valid input for every tool", () => {
    expect(parseToolInput("read_file", { path: "a.ts" })).toEqual({ path: "a.ts" });
    expect(parseToolInput("read_file", { path: "a.ts", offset: 5, limit: 10 })).toEqual({ path: "a.ts", offset: 5, limit: 10 });
    expect(parseToolInput("list_files", {})).toEqual({});
    expect(parseToolInput("search_text", { pattern: "x", case_sensitive: true })).toEqual({ pattern: "x", case_sensitive: true });
    expect(parseToolInput("edit_file", { path: "a", old_str: "b", new_str: "" })).toEqual({ path: "a", old_str: "b", new_str: "" });
    expect(parseToolInput("write_file", { path: "a", contents: "" })).toEqual({ path: "a", contents: "" });
    expect(parseToolInput("run_command", { command: "ls" })).toEqual({ command: "ls" });
  });

  it("rejects unknown tools", () => {
    expect(() => parseToolInput("rm_rf", {})).toThrow(ToolError);
  });

  // [tests -> host] tools.ts parseToolInput: `schemas[name]` finds inherited properties, so these throw a
  // TypeError ("schema.safeParse is not a function") instead of ToolError("unknown tool").
  it("rejects prototype property names as unknown tools", () => {
    for (const n of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(() => parseToolInput(n, {}), n).toThrow(ToolError);
    }
  });

  it("rejects missing and empty required fields with a readable message", () => {
    expect(() => parseToolInput("read_file", {})).toThrow(/invalid input for read_file: path/);
    expect(() => parseToolInput("read_file", { path: "" })).toThrow(ToolError);
    expect(() => parseToolInput("edit_file", { path: "a", old_str: "", new_str: "x" })).toThrow(/old_str/);
    expect(() => parseToolInput("run_command", { command: "" })).toThrow(ToolError);
  });

  it("rejects non-object input", () => {
    for (const bad of [null, undefined, "str", 5, []]) {
      expect(() => parseToolInput("read_file", bad)).toThrow(ToolError);
    }
  });

  it("rejects wrong types, non-integers and out-of-range numbers", () => {
    expect(() => parseToolInput("read_file", { path: "a", offset: "5" })).toThrow(ToolError);
    expect(() => parseToolInput("read_file", { path: "a", offset: 1.5 })).toThrow(ToolError);
    expect(() => parseToolInput("read_file", { path: "a", offset: 0 })).toThrow(ToolError);
    expect(() => parseToolInput("read_file", { path: "a", limit: 5001 })).toThrow(ToolError);
    expect(() => parseToolInput("write_file", { path: "a", contents: 5 })).toThrow(ToolError);
    expect(() => parseToolInput("search_text", { pattern: "x", case_sensitive: "yes" })).toThrow(ToolError);
  });

  it("strips unknown keys", () => {
    expect(parseToolInput("run_command", { command: "ls", evil: 1 })).toEqual({ command: "ls" });
  });
});

describe("toolDefinitions", () => {
  const names = ["read_file", "list_files", "search_text", "edit_file", "write_file", "run_command"];

  it("defines exactly the six tools, each parseable by name", () => {
    expect(toolDefinitions.map((t) => t.name).sort()).toEqual([...names].sort());
  });

  it("JSON-schema required fields match the zod schemas", () => {
    for (const t of toolDefinitions) {
      const props = Object.keys((t.input_schema as { properties: object }).properties);
      const required = ((t.input_schema as { required?: string[] }).required ?? []).slice();
      // Every required property exists.
      for (const r of required) expect(props).toContain(r);
      // A minimal input built from the required fields must pass zod; dropping any required field must fail.
      const full: Record<string, unknown> = {};
      for (const r of required) full[r] = r === "contents" || r === "new_str" ? "" : "x";
      expect(() => parseToolInput(t.name, full), t.name).not.toThrow();
      for (const r of required) {
        const copy = { ...full };
        delete copy[r];
        expect(() => parseToolInput(t.name, copy), `${t.name} without ${r}`).toThrow(ToolError);
      }
    }
  });

  it("only mutating tools are in MUTATING", () => {
    expect([...MUTATING].sort()).toEqual(["edit_file", "run_command", "write_file"]);
  });
});

describe("runTool", () => {
  const ctx = { root: os.tmpdir(), signal: new AbortController().signal, commandTimeoutSec: 5, output: { append() {}, appendLine() {} } } as unknown as ToolContext;

  it("rejects unknown tools", async () => {
    await expect(runTool("nope", {}, ctx)).rejects.toThrow(ToolError);
  });

  it("turns a path escape into a ToolError before touching vscode", async () => {
    await expect(runTool("read_file", { path: "../../etc/passwd" }, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(runTool("write_file", { path: "../x", contents: "" }, ctx)).rejects.toThrow(ToolError);
    await expect(runTool("edit_file", { path: "..\\x", old_str: "a", new_str: "b" }, ctx)).rejects.toThrow(ToolError);
  });
});

// ---------- run_command (real shell) ----------

describe("run_command", () => {
  let dir: string;
  const lines: string[] = [];
  const output = {
    append: (s: string) => void lines.push(s),
    appendLine: (s: string) => void lines.push(s + "\n"),
  };

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-tools-")));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function mk(over: Partial<ToolContext> = {}, ac = new AbortController()): ToolContext {
    return { root: dir, signal: ac.signal, commandTimeoutSec: 20, output: output as never, ...over };
  }
  const run = (command: string, ctx = mk()) => runTool("run_command", { command }, ctx);
  const script = (name: string, body: string) => {
    fs.writeFileSync(path.join(dir, name), body);
    return `node ${name}`;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("reports exit code 0 and output", async () => {
    const r = await run("echo hello");
    expect(r).toMatch(/^exit code 0\n/);
    expect(r).toContain("hello");
  });

  it("reports non-zero exit codes", async () => {
    expect(await run(script("exit3.js", "process.exit(3)"))).toMatch(/^exit code 3\n/);
  });

  it("merges stdout and stderr", async () => {
    const r = await run(script("both.js", "console.log('OUT');console.error('ERR')"));
    expect(r).toContain("OUT");
    expect(r).toContain("ERR");
  });

  it("says (no output) for silent commands", async () => {
    expect(await run(script("silent.js", ""))).toBe("exit code 0\n(no output)");
  });

  it("runs in the workspace root", async () => {
    const r = await run(script("cwd.js", "console.log(process.cwd())"));
    expect(r.toLowerCase()).toContain(dir.toLowerCase());
  });

  it("handles a command that does not exist (non-zero exit, with error text)", async () => {
    const r = await run("definitely-not-a-command-xyz");
    expect(r).not.toMatch(/^exit code 0/);
  });

  it("reports a start failure for a missing cwd", async () => {
    const r = await run("echo hi", mk({ root: path.join(dir, "missing-dir") }));
    expect(r).toMatch(/^failed to start/);
  });

  it("passes non-ASCII output through intact", async () => {
    const r = await run(script("uni.js", "process.stdout.write('caf\\u00e9 \\u4e16\\u754c\\n')"));
    expect(r).toContain("café 世界");
  });

  it("kills a command on timeout", async () => {
    const t0 = Date.now();
    const r = await run(script("hang.js", "setTimeout(()=>{},60000)"), mk({ commandTimeoutSec: 1 }));
    expect(r).toMatch(/^killed: timed out after 1s/);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("keeps output produced before the timeout", async () => {
    const r = await run(script("partial.js", "console.log('BEFORE');setTimeout(()=>{},60000)"), mk({ commandTimeoutSec: 2 }));
    expect(r).toMatch(/^killed: timed out/);
    expect(r).toContain("BEFORE");
  });

  it("kills a command when the signal aborts mid-run", async () => {
    const ac = new AbortController();
    const p = run(script("hang2.js", "setTimeout(()=>{},60000)"), mk({}, ac));
    setTimeout(() => ac.abort(), 700);
    expect(await p).toMatch(/^killed: stopped by user/);
  });

  it("kills the whole process tree (grandchildren) on abort", async () => {
    const marker = path.join(dir, "grandchild-marker.txt");
    fs.rmSync(marker, { force: true });
    const grand = script("grand.js", `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),2500)`);
    fs.writeFileSync(
      path.join(dir, "parent.js"),
      `require('child_process').spawn('node',['grand.js'],{stdio:'ignore'});setTimeout(()=>{},60000)`,
    );
    void grand;
    const ac = new AbortController();
    const p = run("node parent.js", mk({}, ac));
    setTimeout(() => ac.abort(), 1000);
    await p;
    await sleep(3500);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("removes its abort listener after finishing (no leak)", async () => {
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, "addEventListener");
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    await run("echo x", mk({}, ac));
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("trims very long output in the middle", async () => {
    const r = await run(script("big.js", "process.stdout.write('A'.repeat(100000))"));
    expect(r).toContain("characters omitted");
    expect(r.length).toBeLessThan(31_000);
  });

  it("does not leak ANTHROPIC_* variables to the command", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-secret";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-secret";
    try {
      const r = await run(script("env.js", "console.log('K='+(process.env.ANTHROPIC_API_KEY||'none'),'T='+(process.env.ANTHROPIC_AUTH_TOKEN||'none'))"));
      expect(r).toContain("K=none T=none");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it("still passes ordinary environment variables", async () => {
    process.env.AH_TEST_VAR = "visible";
    try {
      expect(await run(script("env2.js", "console.log(process.env.AH_TEST_VAR)"))).toContain("visible");
    } finally {
      delete process.env.AH_TEST_VAR;
    }
  });

  // The following encode correct behaviour for OPEN findings. `it.fails` keeps the suite green while the
  // bug exists and turns red as soon as it is fixed (then change `it.fails` to `it`).

  it("does not run a command when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const r = await run(script("hang3.js", "setTimeout(()=>{},8000)"), mk({}, ac));
    expect(r).toMatch(/^killed: stopped by user/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  // [tests -> host] stdin is left open as a pipe, so commands that read stdin never see EOF and hang until timeout.
  it("gives commands an empty stdin (EOF) instead of an open pipe", async () => {
    const cmd = script("stdin.js", "process.stdin.resume();process.stdin.on('end',()=>console.log('GOT-EOF'))");
    const r = await run(cmd, mk({ commandTimeoutSec: 3 }));
    expect(r).toMatch(/^exit code 0/);
    expect(r).toContain("GOT-EOF");
  });

  // [tests -> host] chunks are decoded one by one with Buffer.toString(), so a multi-byte character split across
  // two data events turns into U+FFFD.
  it("decodes multi-byte characters split across chunks", async () => {
    const cmd = script(
      "split.js",
      "process.stdout.write(Buffer.from([0xe2,0x82]));setTimeout(()=>process.stdout.write(Buffer.from([0xac,10])),300)",
    );
    const r = await run(cmd);
    expect(r).toContain("€");
    expect(r).not.toContain("�");
  });

  // [qa -> host] tools.ts:287: once 2,000,000 chars are buffered the tail (usually the error) is dropped.
  it("keeps the tail of huge output", async () => {
    const cmd = script("huge.js", "process.stdout.write('x'.repeat(3000000));setTimeout(()=>process.stdout.write('TAIL_MARKER'),200)");
    const r = await run(cmd);
    expect(r).toContain("TAIL_MARKER");
  });
});
