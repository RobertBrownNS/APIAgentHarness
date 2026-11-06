import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ Uri: { file: (p: string) => ({ fsPath: p }) } }));

import { isCredentialEnvVar, scrubEnv } from "../src/agent/envFilter";
import { runTool, type ToolContext } from "../src/agent/tools";

describe("isCredentialEnvVar / scrubEnv", () => {
  it.each([
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "GITHUB_TOKEN", "GH_TOKEN",
    "NPM_TOKEN", "NODE_AUTH_TOKEN", "CI_JOB_TOKEN", "MY_API_KEY", "STRIPE_SECRET", "DB_PASSWORD", "DB_PASSWD", "GITHUB_PAT", "SOME_TOKEN", "TOKEN", "KEY", "SECRET", "PASSWORD",
    "AZURE_CLIENT_SECRET", "AZURE_STORAGE_KEY", "AZURE_PASSWORD", "AZURE_TOKEN", "anthropic_api_key", "github_token", "my_secret", "Db_Password",
  ])("credential: %s", (n) => expect(isCredentialEnvVar(n), n).toBe(true));
  it.each(["PATH", "HOME", "USERPROFILE", "TEMP", "SHELL", "LANG", "NODE_ENV", "TERM", "COMSPEC", "SystemRoot", "KEYBOARD", "MONKEY", "TOKENIZER", "PATHEXT", "PWD", "EDITOR", "AZURE_REGION", "CI", "HOMEDRIVE"])(
    "not a credential: %s",
    (n) => expect(isCredentialEnvVar(n), n).toBe(false),
  );
  it("scrubEnv drops credentials and undefined values, keeps the rest unchanged", () => {
    const out = scrubEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", GITHUB_TOKEN: "t", HOME: "/h", EMPTY: undefined, FOO: "bar", AWS_REGION: "x", MY_SECRET: "s" });
    expect(out).toEqual({ PATH: "/bin", HOME: "/h", FOO: "bar" });
  });
  it("scrubEnv returns a copy and does not mutate its input", () => {
    const env = { PATH: "p", MY_KEY: "k" };
    const out = scrubEnv(env);
    out.PATH = "changed";
    expect(env).toEqual({ PATH: "p", MY_KEY: "k" });
  });
});

describe("run_command never sees credential variables", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const SET = { ANTHROPIC_API_KEY: "sk-ant-LEAK", GITHUB_TOKEN: "ghp_LEAK", MY_DB_PASSWORD: "pw-LEAK", AWS_SECRET_ACCESS_KEY: "aws-LEAK", HARMLESS_VAR: "visible" };
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "envscrub-")));
    for (const [k, v] of Object.entries(SET)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const k of Object.keys(SET)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ctx = (): ToolContext => ({ root: dir, signal: new AbortController().signal, commandTimeoutSec: 20, output: { append() {}, appendLine() {} } as never });
  const run = (command: string) => runTool("run_command", { command }, ctx());
  const script = (body: string) => {
    fs.writeFileSync(path.join(dir, "e.js"), body);
    return "node e.js";
  };

  it("echo of a credential variable prints nothing, in the platform shell", async () => {
    const cmd = process.platform === "win32" ? "echo [%ANTHROPIC_API_KEY%]" : "echo [$ANTHROPIC_API_KEY]";
    const out = await run(cmd);
    expect(out).not.toContain("sk-ant-LEAK");
    expect(out).not.toContain("LEAK");
  });
  it("the child process environment has no credential variables, but keeps ordinary ones", async () => {
    const out = await run(script("console.log(JSON.stringify(Object.keys(process.env)))"));
    const keys: string[] = JSON.parse(out.slice(out.indexOf("[")));
    for (const k of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "MY_DB_PASSWORD", "AWS_SECRET_ACCESS_KEY"]) expect(keys, k).not.toContain(k);
    expect(keys).toContain("HARMLESS_VAR");
    expect(keys.some((k) => k.toUpperCase() === "PATH")).toBe(true);
  });
  it("none of the secret values appear anywhere in the environment dump", async () => {
    const out = await run(script("console.log(JSON.stringify(process.env))"));
    for (const v of ["sk-ant-LEAK", "ghp_LEAK", "pw-LEAK", "aws-LEAK"]) expect(out).not.toContain(v);
    expect(out).toContain("visible");
  });
  it("env / printenv / set dumps do not contain them either", async () => {
    const out = await run(process.platform === "win32" ? "set" : "env");
    for (const v of ["sk-ant-LEAK", "ghp_LEAK", "pw-LEAK", "aws-LEAK"]) expect(out).not.toContain(v);
  });
  it("the extension's own process environment is untouched", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-LEAK");
  });
});
