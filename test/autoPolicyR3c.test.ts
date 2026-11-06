import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCommand, checkEdit, globNamesSecrets, isSecretPath, isSensitivePath, normalizePath, writeTargets } from "../src/team/autoPolicy";
import type { CommandClassifier } from "../src/team/types";
import { flush, makeTeam } from "./helpers/fakeTeam";

const ROOT = path.resolve("/ws");
const p = (rel: string) => path.join(ROOT, rel);
const v = (c: string) => checkCommand(c, ROOT).verdict;

describe("isSecretPath", () => {
  const SECRET = [
    ".env", ".env.local", ".env.production", "app/.env", "app/.env.staging", "a.pem", "certs/a.PEM", "a.key", "a.pfx", "a.p12",
    "id_rsa", "keys/id_rsa_old", ".ssh/config", ".ssh/known_hosts", "home/.ssh/id_ed25519", ".npmrc", "pkg/.npmrc",
    ".pypirc", ".yarnrc", ".yarnrc.yml",
    // Windows-isms and case
    ".ENV", ".Env.Local", "ID_RSA", ".SSH/config", ".NPMRC", ".env ", ".env.", ".env::$DATA", ".env...",
  ];
  const PLAIN = ["id_rsa.pub", "src/a.ts", "README.md", "package.json", ".gitignore", "src/env.ts", "src/environment.ts", "docs/ssh.md", "keyboard.ts", "src/key.ts", ".env.example.md".replace(".env.example.md", "example.md")];
  it.each(SECRET)("secret: %s", (rel) => expect(isSecretPath(p(rel), ROOT), rel).toBe(true));
  it.each(PLAIN)("not secret: %s", (rel) => expect(isSecretPath(p(rel), ROOT), rel).toBe(false));
  it("non-string input is not a secret and does not throw", () => {
    for (const x of [undefined, null, 5] as unknown[]) expect(() => isSecretPath(x as string, ROOT)).not.toThrow();
  });
  it("8.3 short names for sensitive files are treated as sensitive edit targets", () => {
    expect(isSensitivePath(p("ENVIRO~1.TXT"), ROOT)).toBe(true);
    expect(isSensitivePath(p("PROGRA~1/x"), ROOT)).toBe(true);
  });
});

describe("globNamesSecrets", () => {
  it.each(["**/.env*", ".env", "*.pem", "**/*.key", "id_rsa*", ".ssh/**", "**/.ssh/*", "{.env,.npmrc}", ".npmrc", "**/.pypirc", ".yarnrc*", "*.PFX", "dir\\.env", "*.p12", "**/ID_RSA*"])(
    "names secrets: %s",
    (g) => expect(globNamesSecrets(g), g).toBe(true),
  );
  it.each(["**/*.ts", "src/**", "*.md", "package.json", "**/*", "*", "", "docs/*.txt", "**/env.ts", "keyboard*"])("does not: %j", (g) => {
    expect(globNamesSecrets(g), g).toBe(false);
  });
  it("undefined is false", () => {
    expect(globNamesSecrets(undefined)).toBe(false);
  });
  it.fails("non-string input does not throw (GAP: TypeError on glob.replace; tool input is zod-validated, so low)", () => {
    expect(() => globNamesSecrets(5 as never)).not.toThrow();
  });
});

describe("extended sensitive edit paths", () => {
  it.each([
    ".claude/settings.json", ".claude/commands/x.md", ".cursor/rules", ".devcontainer/devcontainer.json", ".mcp.json", ".gitattributes",
    ".gitmodules", ".yarnrc", ".yarnrc.yml", ".pypirc", ".husky/pre-commit", ".github/workflows/ci.yml", "node_modules/.bin/tsc", "Makefile",
    "build.sh", "run.bat", "x.cmd", "setup.ps1", ".npmrc", ".git/config", ".vscode/tasks.json", ".ssh/config",
    ".env.local", "a.pem", "id_rsa",
    // variants
    ".CLAUDE/settings.json", ".Mcp.Json", "BUILD.SH", "RUN.BAT", "makefile", ".claude./x", ".claude /x",
  ])("asks: %s", (rel) => {
    expect(checkEdit(p(rel), ROOT).verdict, rel).toBe("ask");
    expect(isSensitivePath(p(rel), ROOT), rel).toBe(true);
  });
  it.each(["src/a.ts", "README.md", "tsconfig.json", ".gitignore", ".eslintrc.json", ".prettierrc", "docs/guide.md", "package.json", "sub/package.json", "src/claude.ts", "src/cursor.ts", "src/make.ts", "scripts.md"])("allows: %s", (rel) => {
    expect(checkEdit(p(rel), ROOT).verdict, rel).toBe("allow");
  });
});

describe("git reading secrets", () => {
  it.each([
    "git show HEAD:.env",
    "git show main:.env.local",
    "git show HEAD~3:config/.env",
    "git show HEAD:certs/a.pem",
    "git cat-file -p HEAD:.env",
    "git cat-file blob HEAD:.ssh/config",
    "git diff HEAD -- .env",
    "git diff -- .env.local",
    "git log -p -- .env",
    "git log -p -- certs/server.key",
    "git archive HEAD .env",
    "git archive HEAD -- .npmrc",
    "git blame .env",
    "git grep token -- .env",
    "git show HEAD:id_rsa",
    "GIT SHOW HEAD:.ENV",
  ])("asks: %s", (c) => expect(v(c), c).toBe("ask"));
  it.each(["git show HEAD:src/a.ts", "git show HEAD", "git diff -- src/a.ts", "git log -p -- src/a.ts", ])("still allowed: %s", (c) => {
    expect(v(c), c).toBe("allow");
  });
  it.each(["git cat-file -p HEAD:README.md", "git blame src/a.ts"])("not refused (classifier decides): %s", (c) => {
    expect(v(c), c).not.toBe("ask");
  });
});

describe("recursive grep is not allowlisted", () => {
  it.each(["grep -rn foo src", "grep -r foo .", "grep -R foo .", "grep --recursive foo .", "grep -d recurse foo .", "grep --directories=recurse foo .", "grep -rin foo src", "findstr /s foo *.ts"])(
    "classify: %s",
    (c) => expect(v(c), c).toBe("classify"),
  );
  it("rg stays allowed, plain grep stays allowed", () => {
    expect(v("rg foo src")).toBe("allow");
    expect(v("grep foo src/a.ts")).toBe("allow");
  });
  it("a recursive grep naming a secret asks", () => {
    expect(v("grep -r token .env")).toBe("ask");
    expect(v("grep -r token .ssh")).toBe("ask");
  });
});

describe("writeTargets", () => {
  const t = (c: string) => writeTargets(c, ROOT);
  const n = (rel: string) => normalizePath(path.resolve(ROOT, rel));
  it("redirects", () => {
    expect(t("echo hi > out.txt")).toEqual([n("out.txt")]);
    expect(t("echo hi >> out.txt")).toEqual([n("out.txt")]);
    expect(t("echo hi 1> out.txt")).toEqual([n("out.txt")]);
    expect(t("echo hi >out.txt")).toEqual([n("out.txt")]);
    expect(t("echo hi &> out.txt")).toEqual([n("out.txt")]);
  });
  it("ignores /dev/null, nul and fd duplication", () => {
    expect(t("ls > /dev/null")).toEqual([]);
    expect(t("ls > nul")).toEqual([]);
    expect(t("ls 2>&1")).toEqual([]);
    expect(t("ls 2> /dev/null")).toEqual([]);
  });
  it("tee, Set-Content, Add-Content, Out-File", () => {
    expect(t("echo x | tee a.txt")).toEqual([n("a.txt")]);
    expect(t("echo x | tee -a a.txt b.txt")).toEqual([n("a.txt"), n("b.txt")]);
    expect(t("Set-Content a.txt 'x'").map(String)).toContain(n("a.txt"));
    expect(t("Add-Content a.txt x")).toContain(n("a.txt"));
    expect(t("echo x | Out-File a.txt")).toContain(n("a.txt"));
  });
  it("cp / mv / copy / move / xcopy: the last argument", () => {
    for (const c of ["cp a.txt b.txt", "mv a.txt b.txt", "copy a.txt b.txt", "move a.txt b.txt", "xcopy a.txt b.txt"]) expect(t(c), c).toEqual([n("b.txt")]);
  });
  it("curl -o / --output and wget -O / --output-document", () => {
    expect(t("curl http://x -o dl.js")).toEqual([n("dl.js")]);
    expect(t("curl http://x --output dl.js")).toEqual([n("dl.js")]);
    expect(t("wget http://x -O dl.js")).toEqual([n("dl.js")]);
    expect(t("wget http://x --output-document dl.js")).toEqual([n("dl.js")]);
  });
  it("covers every segment of a chain and dedupes", () => {
    expect(t("echo a > x.txt; echo b > y.txt && echo c >> x.txt").sort()).toEqual([n("x.txt"), n("y.txt")].sort());
  });
  it("paths are resolved against root and normalised (case, slashes)", () => {
    expect(t("echo a > Sub\\\\File.TXT")[0]).toBe(n("sub/file.txt"));
  });
  it("nothing for read-only commands; no throw on junk", () => {
    expect(t("ls -la")).toEqual([]);
    expect(t("git status")).toEqual([]);
    for (const c of ["", "   ", ">", "> ", "tee", "cp", "curl -o"]) expect(() => t(c), c).not.toThrow();
    for (const x of [undefined, null, 5] as unknown[]) expect(() => writeTargets(x as string, ROOT)).not.toThrow();
  });
});

type T = ReturnType<typeof makeTeam>;
let cur: T | undefined;
afterEach(() => {
  cur?.team.dispose();
  cur = undefined;
});
const allow = (): CommandClassifier => vi.fn(async () => ({ verdict: "allow", reason: "ok" }) as never);
const setup = (over = {}, cls?: CommandClassifier): T => (cur = makeTeam(over, { classify: cls }));
const sig = () => new AbortController().signal;
const pending = (t: T) => t.team.approvals.pending();

describe("Team.authorize: read tools naming secrets ask in every mode", () => {
  const MODES = ["plan", "normal", "auto"] as const;
  describe.each(MODES)("%s mode", (mode) => {
    it("read_file on a secret path asks with 'reads a secrets file'", async () => {
      const t = setup({ defaultMode: mode }, allow());
      void t.team.authorize({ id: "r1", agent: "main", tool: "read_file", input: { path: ".env" }, absPath: p(".env") }, sig());
      await flush();
      expect(pending(t)).toHaveLength(1);
      expect(pending(t)[0].askReason).toBe("reads a secrets file");
      expect(pending(t)[0].coverable).toBe(false);
    });
    it.each([["list_files", { glob: "**/.env*" }], ["search_text", { pattern: "x", glob: "*.pem" }], ["search_text", { pattern: "x", glob: ".ssh/**" }]])(
      "%s with a glob that names secrets asks",
      async (tool, input) => {
        const t = setup({ defaultMode: mode }, allow());
        void t.team.authorize({ id: "r2", agent: "main", tool, input }, sig());
        await flush();
        expect(pending(t)).toHaveLength(1);
        expect(pending(t)[0].askReason).toBe("reads a secrets file");
      },
    );
    it("approving lets the read through; rejecting refuses it", async () => {
      const t = setup({ defaultMode: mode });
      const a = t.team.authorize({ id: "r3", agent: "main", tool: "read_file", input: { path: ".env" }, absPath: p(".env") }, sig());
      t.team.approval("r3", "approve");
      expect((await a).approved).toBe(true);
      const b = t.team.authorize({ id: "r4", agent: "main", tool: "read_file", input: { path: ".env" }, absPath: p(".env") }, sig());
      t.team.approval("r4", "reject", "no");
      expect((await b).approved).toBe(false);
    });
    it("approve-all never covers secret reads", async () => {
      const t = setup({ defaultMode: mode });
      const a = t.team.authorize({ id: "r5", agent: "main", tool: "read_file", input: { path: ".env" }, absPath: p(".env") }, sig());
      t.team.approval("r5", "approveAll");
      await a;
      void t.team.authorize({ id: "r6", agent: "main", tool: "read_file", input: { path: ".env.local" }, absPath: p(".env.local") }, sig());
      await flush();
      expect(pending(t).map((r) => r.id)).toEqual(["r6"]);
    });
  });
  it("auto mode still auto-approves ordinary reads and ordinary globs", async () => {
    const t = setup({ defaultMode: "auto" });
    const r = await t.team.authorize({ id: "a", agent: "main", tool: "read_file", input: { path: "src/a.ts" }, absPath: p("src/a.ts") }, sig());
    expect(r.approved).toBe(true);
    const g = await t.team.authorize({ id: "b", agent: "main", tool: "search_text", input: { pattern: "x", glob: "**/*.ts" } }, sig());
    expect(g.approved).toBe(true);
    expect(pending(t)).toEqual([]);
  });
  it("normal mode queues ordinary reads only if the loop asks (reads are normally auto-approved by the loop)", async () => {
    const t = setup({ defaultMode: "normal" });
    void t.team.authorize({ id: "a", agent: "main", tool: "read_file", input: { path: "src/a.ts" }, absPath: p("src/a.ts") }, sig());
    await flush();
    expect(pending(t)).toHaveLength(1);
  });
  it("secret reads by a teammate attribute the request to that teammate", async () => {
    const t = setup({ defaultMode: "auto" });
    t.team.spawnTeammate({ name: "bob", role: "r", prompt: "p" }, "main");
    void t.team.authorize({ id: "x", agent: "bob", tool: "read_file", input: { path: ".env" }, absPath: p(".env") }, sig());
    await flush();
    expect(pending(t)[0].agent).toBe("bob");
  });
  it("a command that reads a secret asks in auto mode without calling the classifier", async () => {
    const cls = allow();
    const t = setup({ defaultMode: "auto" }, cls);
    void t.team.authorize({ id: "c", agent: "main", tool: "run_command", input: { command: "cat .env" } }, sig());
    await flush();
    expect(cls).not.toHaveBeenCalled();
    expect(pending(t)).toHaveLength(1);
  });
});

describe("second present_plan and new-teammate notes", () => {
  const PLAN = { title: "T", summary: "S", steps: [{ title: "one" }] };
  it("a second present_plan while one is pending errors and adds no second card or request", async () => {
    const t = setup({ defaultMode: "plan" });
    const first = t.team.presentPlan({ id: "p1", agent: "main", ...PLAN }, sig());
    await flush();
    await expect(t.team.presentPlan({ id: "p2", agent: "main", ...PLAN }, sig())).rejects.toBeDefined();
    expect(t.agents.get("main")!.transcript.filter((i) => i.kind === "plan")).toHaveLength(1);
    expect(pending(t).map((r) => r.id)).toEqual(["p1"]);
    t.team.planDecision("p1", false, undefined, "no");
    await first;
  });
  it("after the first plan is answered, a new plan can be presented", async () => {
    const t = setup({ defaultMode: "plan" });
    const first = t.team.presentPlan({ id: "p1", agent: "main", ...PLAN }, sig());
    t.team.planDecision("p1", false, undefined, "revise");
    await first;
    const second = t.team.presentPlan({ id: "p2", agent: "main", ...PLAN }, sig());
    await flush();
    expect(pending(t).map((r) => r.id)).toEqual(["p2"]);
    t.team.planDecision("p2", true, "normal");
    expect((await second).approved).toBe(true);
  });
  it.each([["plan", /Plan/], ["auto", /Auto/]] as const)("a teammate spawned in %s mode starts with that mode's note", (mode, re) => {
    const t = setup({ defaultMode: mode });
    t.team.spawnTeammate({ name: "bob", role: "r", prompt: "p" }, "main");
    expect(t.team.drainSystemNotes("bob")).toEqual([expect.stringMatching(re)]);
  });
  it("a teammate spawned in normal mode gets no note", () => {
    const t = setup();
    t.team.spawnTeammate({ name: "bob", role: "r", prompt: "p" }, "main");
    expect(t.team.drainSystemNotes("bob")).toEqual([]);
  });
});
