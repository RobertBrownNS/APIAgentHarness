import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// What findFiles returns is set per test.
let found: string[] = [];
vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  RelativePattern: class {
    constructor(
      public base: string,
      public pattern: string,
    ) {}
  },
  workspace: {
    findFiles: async () => found.map((p) => ({ fsPath: p })),
    fs: {
      stat: async (u: { fsPath: string }) => ({ size: fs.statSync(u.fsPath).size }),
      readFile: async (u: { fsPath: string }) => new Uint8Array(fs.readFileSync(u.fsPath)),
    },
  },
}));

import { pathForAuthorize, isSecretEither, realOrSelf } from "../src/agent/secretPaths";
import { runTool, type ToolContext } from "../src/agent/tools";
import { checkCommand, globNamesSecrets, isSecretPath } from "../src/team/autoPolicy";

let root: string;
const p = (rel: string) => path.join(root, rel);
const w = (rel: string, text = "token=hunter2\nhello\n") => {
  fs.mkdirSync(path.dirname(p(rel)), { recursive: true });
  fs.writeFileSync(p(rel), text);
};
let ctx: ToolContext;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secrets-")));
  ctx = { root, signal: new AbortController().signal, commandTimeoutSec: 5, output: { append() {}, appendLine() {} } } as unknown as ToolContext;
  for (const f of ["src/a.ts", "README.md", ".env", ".env.local", ".env.example", "certs/server.pem", "id_rsa", "id_rsa.pub", ".ssh/config", ".aws/credentials", "notes.txt"]) w(f);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const ROOT = path.resolve("/ws");
const q = (rel: string) => path.join(ROOT, rel);

describe("isSecretPath: names", () => {
  const SECRET = [
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "keys/id_ed25519", "a.pem", "a.key", "a.pfx", "a.p12", "a.keystore", "a.jks", "vpn.ovpn",
    ".ssh/config", "x/.ssh/known_hosts", ".aws/credentials", ".aws/config", ".kube/config", ".docker/config.json", ".gnupg/pubring.kbx", ".azure/accessTokens.json",
    ".netrc", "_netrc", ".git-credentials", ".pgpass", ".htpasswd", ".pypirc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".env", ".env.local", ".env.production", "app/.env",
    "vault.kdbx", "terraform.tfstate", "terraform.tfstate.backup", "prod.tfvars", "credentials", "credentials.json", "secret", "secrets.yml", "secrets/x.txt".replace("secrets/x.txt", "secret.txt"),
    "gcp-service-account.json", "my_service_account.json", "service-account-key.json",
    // Windows normalisation and case
    ".ENV", "ID_RSA", "A.PEM", ".SSH/config", ".AWS/credentials", ".Netrc", ".env ", ".env.", ".env::$DATA", ".netrc.", "CREDENTIALS.JSON", "Secrets.YML",
  ];
  const NOT_SECRET = [
    "id_rsa.pub", "id_ed25519.pub", "a.pub", ".env.example", ".env.sample", ".env.template", ".env.dist", "src/a.ts", "README.md", "package.json", "identity.ts", "src/env.ts",
    "src/environment.ts", "docs/ssh.md", "keyboard.ts", "src/credentialsHelper.ts".replace("credentialsHelper", "creds"), "tsconfig.json", ".gitignore", "src/secretary.ts".replace("secretary", "agenda"),
  ];
  it.each(SECRET)("secret: %s", (rel) => expect(isSecretPath(q(rel), ROOT), rel).toBe(true));
  it.each(NOT_SECRET)("not secret: %s", (rel) => expect(isSecretPath(q(rel), ROOT), rel).toBe(false));
});

describe("globNamesSecrets: names", () => {
  it.each([
    "**/.env*", ".env", "*.pem", "*.key", "id_rsa*", "id_ed25519", ".ssh/**", ".aws/**", ".kube/*", ".docker/**", ".gnupg/**", ".azure/**", ".netrc",
    ".git-credentials", ".pgpass", ".htpasswd", ".pypirc", ".npmrc", ".yarnrc*", "*.kdbx", "*.tfstate", "*.tfvars", "credentials*", "secrets*",
    "**/*service-account*", "**/*service_account*",
  ])("names secrets: %s", (g) => expect(globNamesSecrets(g), g).toBe(true));
  it.each(["_netrc", "*.keystore", "*.jks", "*.ovpn"])("names secrets: %s", (g) => expect(globNamesSecrets(g), g).toBe(true));
  it.each(["src/**/*.ts", "*.md", "**/*.ts", "**/*", "package.json", "*.pub", "docs/**"])("does not: %s", (g) => expect(globNamesSecrets(g), g).toBe(false));
  it("undefined is false", () => expect(globNamesSecrets(undefined)).toBe(false));
});

describe("git reading secrets and recursive grep (policy)", () => {
  const v = (c: string) => checkCommand(c, ROOT).verdict;
  it.each(["git show HEAD:.env", "git cat-file -p HEAD:.aws/credentials", "git diff -- .ssh/config", "git log -p -- certs/a.pem", "git archive HEAD .netrc", "git show main:secrets.yml"])(
    "asks: %s",
    (c) => expect(v(c), c).toBe("ask"),
  );
  it.each(["git show HEAD:src/a.ts", "git show HEAD:.env.example", "git diff -- src/a.ts", "git show HEAD:id_rsa.pub"])("allowed: %s", (c) => expect(v(c), c).toBe("allow"));
  it.each(["grep -rn foo src", "grep -r foo .", "grep -R foo .", "grep --recursive foo .", "grep -d recurse foo .", "grep --directories=recurse foo ."])("classify: %s", (c) =>
    expect(v(c), c).toBe("classify"),
  );
  it.each(["cat .env", "cat .aws/credentials", "type .ssh\\config", "head .netrc", "grep token .env", "rg token .git-credentials"])("reading a secret asks: %s", (c) =>
    expect(v(c), c).toBe("ask"),
  );
});

describe("creating links always asks", () => {
  it.each([
    "ln file link",
    "ln -s target link",
    "ln -sf target link",
    "ln -s ../.env x",
    "LN -S a b",
    "ls; ln -s a b",
    "ls && ln a b",
    "mklink link target",
    "mklink /H link target",
    "mklink /J link target",
    "mklink /D link target",
    "MKLINK link target",
    "cmd /c mklink link target",
    "cmd /c \"mklink /J a b\"",
    "New-Item -ItemType SymbolicLink -Path a -Target b",
    "New-Item -ItemType HardLink -Path a -Target b",
    "New-Item -ItemType Junction -Path a -Target b",
    "New-Item -Type SymbolicLink -Path a -Target b",
    "ni -ItemType SymbolicLink a -Value b",
    "ni -Type Junction a b",
    "new-item -itemtype symboliclink -path a -target b",
    "fsutil hardlink create link target",
    "FSUTIL HARDLINK CREATE link target",
    "echo hi; fsutil hardlink create a b",
  ])("asks: %s", (c) => expect(checkCommand(c, ROOT).verdict, c).toBe("ask"));
  it("ordinary New-Item and words containing ln are fine", () => {
    expect(checkCommand("New-Item -ItemType Directory out", ROOT).verdict).not.toBe("ask");
    expect(checkCommand("echo lnx", ROOT).verdict).toBe("allow");
    expect(checkCommand("npm run build", ROOT).verdict).not.toBe("allow"); // no scriptBody given
  });
});

describe("secretPaths: symlinks and junctions", () => {
  let linkOk = true;
  const link = (target: string, name: string) => {
    try {
      fs.symlinkSync(target, p(name), process.platform === "win32" && fs.statSync(target).isDirectory() ? "junction" : "file");
      return true;
    } catch {
      linkOk = false;
      return false;
    }
  };
  it("realOrSelf returns the path itself for a missing file", () => {
    expect(realOrSelf(p("missing.txt"))).toBe(p("missing.txt"));
  });
  it("a plain secret and a plain harmless file", () => {
    expect(isSecretEither(p(".env"), root)).toBe(true);
    expect(isSecretEither(p("src/a.ts"), root)).toBe(false);
    expect(isSecretEither(p("does-not-exist.txt"), root)).toBe(false);
    expect(isSecretEither(p("does-not-exist/.env"), root)).toBe(true);
  });
  it("a link named harmlessly that points at .env is secret", () => {
    if (!link(p(".env"), "notes-link.txt")) return;
    expect(isSecretEither(p("notes-link.txt"), root)).toBe(true);
  });
  it("a link named .env that points at a harmless file is still secret (judged by its own name)", () => {
    if (!linkOk) return;
    fs.mkdirSync(p("sub"), { recursive: true });
    w("sub/plain.txt");
    try {
      fs.symlinkSync(p("sub/plain.txt"), p("sub/.env"), "file");
    } catch {
      return;
    }
    expect(isSecretEither(p("sub/.env"), root)).toBe(true);
  });
  it("a link to a harmless file is not secret", () => {
    if (!linkOk) return;
    if (!link(p("src/a.ts"), "harmless-link.ts")) return;
    expect(isSecretEither(p("harmless-link.ts"), root)).toBe(false);
  });
  it("a junction/link to a directory holding secrets exposes them through the link path", () => {
    if (!linkOk) return;
    try {
      fs.symlinkSync(p(".ssh"), p("docs-link"), "junction");
    } catch {
      return;
    }
    expect(isSecretEither(p("docs-link/config"), root)).toBe(true);
  });
  it("pathForAuthorize: secret or sensitive paths are returned as given", () => {
    expect(pathForAuthorize(p(".env"), root)).toBe(p(".env"));
    expect(pathForAuthorize(p(".git/config"), root)).toBe(p(".git/config"));
  });
  it("pathForAuthorize: a harmless-looking link to .env returns the resolved .env path", () => {
    if (!linkOk) return;
    const out = pathForAuthorize(p("notes-link.txt"), root);
    expect(path.basename(out)).toBe(".env");
  });
  it("pathForAuthorize: a harmless existing file resolves to itself, a missing one to itself", () => {
    expect(pathForAuthorize(p("src/a.ts"), root)).toBe(realOrSelf(p("src/a.ts")));
    expect(pathForAuthorize(p("missing/x.ts"), root)).toBe(p("missing/x.ts"));
  });
});

describe("list_files / search_text hide secret files and say how many", () => {
  const all = () => ["src/a.ts", "README.md", ".env", ".env.local", ".env.example", "certs/server.pem", "id_rsa", "id_rsa.pub", ".ssh/config", ".aws/credentials", "notes.txt"].map(p);
  it("list_files omits secret files and appends the hidden count", async () => {
    found = all();
    const out = await runTool("list_files", {}, ctx);
    for (const keep of ["src/a.ts", "README.md", ".env.example", "id_rsa.pub", "notes.txt"]) expect(out, keep).toContain(keep.replace(/\//g, path.sep) === keep ? keep : keep);
    for (const hide of [".env.local", "server.pem", ".ssh", ".aws"]) expect(out, hide).not.toContain(hide);
    expect(out).not.toMatch(/(^|\n)\.env(\n|$)/);
    expect(out).not.toMatch(/(^|\n)id_rsa(\n|$)/);
    expect(out).toMatch(/\(6 secret files hidden; use read_file to request access\)/);
  });
  it("singular: one hidden file says 'file', not 'files'", async () => {
    found = [p("src/a.ts"), p(".env")];
    const out = await runTool("list_files", {}, ctx);
    expect(out).toContain("(1 secret file hidden; use read_file to request access)");
  });
  it("no secrets, no note", async () => {
    found = [p("src/a.ts"), p("README.md")];
    const out = await runTool("list_files", {}, ctx);
    expect(out).not.toMatch(/hidden/);
  });
  it("only secrets: 'No files matched.' plus the note", async () => {
    found = [p(".env"), p("id_rsa")];
    const out = await runTool("list_files", {}, ctx);
    expect(out).toMatch(/^No files matched\./);
    expect(out).toMatch(/2 secret files hidden/);
  });
  it("search_text never reads or returns matches from secret files", async () => {
    found = all();
    const out = await runTool("search_text", { pattern: "hunter2" }, ctx);
    expect(out).not.toMatch(/\.env(\.local)?:/);
    expect(out).not.toMatch(/server\.pem|id_rsa:|\.ssh|\.aws|credentials/);
    expect(out).toContain("a.ts:1");
    expect(out).toMatch(/6 secret files hidden/);
  });
  it("search_text with only secret hits says No matches plus the note, and leaks no content", async () => {
    found = [p(".env"), p(".env.local")];
    const out = await runTool("search_text", { pattern: "hunter2" }, ctx);
    expect(out).toMatch(/^No matches\./);
    expect(out).not.toContain("hunter2");
    expect(out).toMatch(/2 secret files hidden/);
  });
  it("a harmless-named link to a secret is hidden too", async () => {
    const lnk = p("notes-link.txt");
    if (!fs.existsSync(lnk)) return; // symlink creation was not permitted on this machine
    found = [lnk, p("src/a.ts")];
    const out = await runTool("list_files", {}, ctx);
    expect(out).not.toContain("notes-link.txt");
    expect(out).toMatch(/1 secret file hidden/);
    const s = await runTool("search_text", { pattern: "hunter2" }, ctx);
    expect(s).not.toContain("notes-link");
  });
  it("files outside the workspace are dropped, not counted as secrets", async () => {
    found = [path.join(os.tmpdir(), "outside-file.txt"), p("src/a.ts")];
    const out = await runTool("list_files", {}, ctx);
    expect(out).not.toContain("outside-file");
    expect(out).not.toMatch(/hidden/);
  });
  it("the hidden count is exact for a large mixed result", async () => {
    found = [];
    for (let i = 0; i < 30; i++) {
      w(`bulk/f${i}.txt`);
      found.push(p(`bulk/f${i}.txt`));
    }
    for (let i = 0; i < 7; i++) {
      w(`bulk/k${i}.pem`);
      found.push(p(`bulk/k${i}.pem`));
    }
    const out = await runTool("list_files", {}, ctx);
    expect(out).toContain("(7 secret files hidden");
    expect(out.split("\n").filter((l) => l.startsWith("bulk")).length).toBe(30);
  });
});
