import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCommand, normalizePath, packageJsonRisk, type PolicyContext } from "../src/team/autoPolicy";

/** Regression tests for the reviewer's #52 repros (widened-allowlist bypasses). A real temp workspace is used for globs. */
let root: string;
const SCRIPTS: Record<string, Record<string, string>> = {};
const n = (rel: string) => normalizePath(path.join(root, rel));

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bypass52-")));
  for (const f of [".env", ".env.local", "id_rsa", "id_rsa.pub", "credentials.json", "secrets.yml", "README.md", "a.ts", "b.ts", "sub/run.js", "sub/ok.js", "fresh.js", "written.json", "plugin_mod.py", "keep.txt", ".gitignore"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x");
  }
  fs.mkdirSync(path.join(root, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ssh", "config"), "x");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const ctx = (extra: Partial<PolicyContext> = {}): PolicyContext => ({
  written: new Set([n("written.json"), n("sub/run.js"), n("plugin_mod.py"), n("wrote.js")]),
  freshFile: (p) => normalizePath(p) === n("fresh.js"),
  scriptBody: (name) => ({ test: "vitest run", build: "tsc -p tsconfig.json", lint: "eslint src" })[name],
  ...extra,
});
const v = (c: string, extra: Partial<PolicyContext> = {}) => checkCommand(c, root, ctx(extra)).verdict;

describe("#52.1 runner options naming written or fresh files", () => {
  it.each([
    "eslint -c fresh.js .",
    "npx eslint -c fresh.js .",
    "npx eslint --config fresh.js .",
    "npx eslint --config=fresh.js .",
    "vitest --config fresh.js",
    "vitest run --config=fresh.js",
    "vitest run --setupFiles fresh.js",
    "vitest run --setupFiles=fresh.js",
    "vitest run --reporter fresh.js",
    "vitest run --globalSetup fresh.js",
    "npx prettier --check --plugin fresh.js .",
    "npx prettier --check --config fresh.js .",
    "prettier --check --config=fresh.js .",
    "pytest -p plugin_mod",
    "pytest -p plugin_mod tests",
    "pytest --pyargs plugin_mod",
    "pytest -c fresh.js",
    "npm test -- --config fresh.js",
    "npm test -- --config=fresh.js",
    "npm run build -- -p written.json",
    "npm run lint -- --config written.json",
    "npm run lint -- -c written.json",
    "tsc -p written.json",
    "npx tsc --project written.json",
    "tsc -p=written.json".replace("-p=", "--project="),
    "jest --config written.json",
    "jest --setupFiles fresh.js",
    "mocha --require fresh.js",
    "mocha -r fresh.js",
    "node --require fresh.js sub/ok.js",
    "node --import fresh.js sub/ok.js",
    "node --loader fresh.js sub/ok.js",
    "vitest run --preset fresh.js",
    "vitest run --transform fresh.js",
    "VITEST=1 vitest run --config fresh.js",
    "npx vitest run --config ./fresh.js",
    "npx vitest run --config .\\fresh.js",
    "npx vitest run --config sub/../fresh.js",
  ])("asks: %s", (c) => expect(v(c), c).toBe("ask"));
  it("module-name options probe common extensions (.py .js .mjs .cjs .ts .json)", () => {
    for (const ext of ["py", "js", "mjs", "cjs", "ts", "json"]) {
      const c = checkCommand("pytest -p modx", root, {
        written: new Set([n(`modx.${ext}`)]),
      });
      expect(c.verdict, ext).toBe("ask");
    }
  });
  it("positional test files and ordinary option values are still fine", () => {
    expect(v("vitest run a.ts")).toBe("allow");
    expect(v("npx vitest run --reporter=verbose")).toBe("allow");
    expect(v("npx vitest run --reporter dot")).toBe("allow");
    expect(v("eslint -c .eslintrc.json .")).not.toBe("ask");
    expect(v("pytest -p no:cacheprovider")).not.toBe("ask");
    expect(v("npm test -- --reporter=dot")).toBe("allow");
    expect(v("tsc -p tsconfig.json")).toBe("allow");
  });
  it("a written or fresh file after -- is checked too", () => {
    expect(v("npm test -- fresh.js")).not.toBe("deny");
    expect(["ask", "classify"]).toContain(v("npm test -- --config fresh.js"));
  });
});

describe("#52.2 secret reads by glob", () => {
  it.each([
    "cat .e*",
    "cat .env*",
    "cat .??*",
    "cat .[e]nv",
    "cat .en?",
    "cat .*",
    "Get-Content .e*",
    "Get-Content .*",
    "type .e*",
    "head .e*",
    "tail .e*",
    "grep token .e*",
    "rg token .e*",
    "findstr token .e*",
    "cat id_*",
    "cat id_r*",
    "cat cred*",
    "cat sec*",
    "cat *",
    "cat ./.e*",
    "cat .s*/config",
    "cat .ss?/config",
    "head -n 5 .env*",
    "grep -n x *",
    "ls | cat .e*".replace("ls | ", ""),
  ])("asks: %s", (c) => expect(v(c), c).toBe("ask"));
  it.each(["cat *.ts", "cat README*", "cat a.*", "cat ?.ts", "cat [ab].ts", "ls *.ts", "grep x *.ts", "head -n 3 sub/*.js", "cat README.md", "ls", "cat .gitignore"])("allowed: %s", (c) => {
    expect(v(c), c).not.toBe("ask");
  });
  it("a glob with no match is not an error (it just expands to nothing)", () => {
    expect(v("cat *.nomatch")).not.toBe("ask");
  });
  it("a glob in a folder name that reaches a secret asks", () => {
    expect(v("cat .s*sh/config")).toBe("ask");
    expect(v("cat */.env")).not.toBe("allow");
  });
  it.each([
    "rg --hidden x",
    "rg --hidden token .",
    "rg -u x",
    "rg -uu x",
    "rg -uuu x .",
    "rg --unrestricted x",
    "rg --no-ignore x",
    "rg --no-ignore-vcs x",
    "rg --no-ignore-parent x",
    "rg --no-ignore-dot x",
    "RG --HIDDEN x",
    "rg -n --hidden x src",
    "rg x -u",
  ])("ripgrep that searches hidden or ignored files asks: %s", (c) => expect(v(c), c).toBe("ask"));
  it("plain rg stays allowed", () => {
    expect(v("rg foo")).toBe("allow");
    expect(v("rg -n foo src")).toBe("allow");
    expect(v("rg -i --glob '*.ts' foo")).not.toBe("ask");
  });
  it("brace expansion that names a secret asks", () => {
    expect(v("cat {.env,README.md}")).toBe("ask");
    expect(v("cat .{env,ssh/config}")).toBe("ask");
  });
});

describe("#52.3 package.json risk is an allowlist", () => {
  const base = { name: "x", version: "1.0.0", scripts: { test: "vitest run" }, dependencies: { zod: "^3.0.0" } };
  const pkg = (o: Record<string, unknown>) => JSON.stringify(o);
  const risk = (next: Record<string, unknown>) => packageJsonRisk(pkg(base), pkg({ ...base, ...next }));
  it.each([
    ["version", { version: "2.0.0" }],
    ["description", { description: "d" }],
    ["license", { license: "MIT" }],
    ["keywords", { keywords: ["a"] }],
    ["author", { author: "me" }],
    ["repository", { repository: "github:me/x" }],
    ["homepage", { homepage: "https://x.test" }],
    ["private", { private: true }],
    ["engines", { engines: { node: ">=20" } }],
    ["files", { files: ["dist"] }],
    ["dependency with a semver range", { dependencies: { zod: "^3.0.0", lodash: "^4.17.0" } }],
    ["dependency with exact version", { dependencies: { zod: "3.22.4" } }],
    ["dependency with a tag", { dependencies: { zod: "latest" } }],
    ["dependency with a tilde/range/x", { dependencies: { zod: "~3.0.0", a: ">=1 <2", b: "1.x", c: "*" } }],
    ["devDependencies plain", { devDependencies: { vitest: "^3.0.0" } }],
  ])("harmless: %s", (_n, change) => expect(risk(change)).toBeUndefined());
  it.each([
    ["file: dependency", { dependencies: { zod: "^3.0.0", evil: "file:../evil" } }],
    ["link: dependency", { dependencies: { zod: "^3.0.0", evil: "link:../evil" } }],
    ["git+https dependency", { dependencies: { zod: "^3.0.0", evil: "git+https://x.test/e.git" } }],
    ["git:// dependency", { dependencies: { zod: "^3.0.0", evil: "git://x.test/e.git" } }],
    ["github: dependency", { dependencies: { zod: "^3.0.0", evil: "github:me/evil" } }],
    ["user/repo shorthand", { dependencies: { zod: "^3.0.0", evil: "me/evil" } }],
    ["https URL dependency", { dependencies: { zod: "^3.0.0", evil: "https://x.test/e.tgz" } }],
    ["npm: alias", { dependencies: { zod: "^3.0.0", evil: "npm:other@1" } }],
    ["workspace: protocol", { dependencies: { zod: "workspace:*" } }],
    ["file: in devDependencies", { devDependencies: { evil: "file:../evil" } }],
    ["file: in optionalDependencies", { optionalDependencies: { evil: "file:../evil" } }],
    ["file: in peerDependencies", { peerDependencies: { evil: "file:../evil" } }],
    ["changing an existing dep to file:", { dependencies: { zod: "file:../evil" } }],
    ["main", { main: "evil.js" }],
    ["exports", { exports: "./evil.js" }],
    ["type", { type: "module" }],
    ["module", { module: "evil.mjs" }],
    ["browser", { browser: "evil.js" }],
    ["workspaces", { workspaces: ["packages/*"] }],
    ["overrides", { overrides: { zod: "file:../evil" } }],
    ["resolutions", { resolutions: { zod: "file:../evil" } }],
    ["pnpm", { pnpm: { overrides: {} } }],
    ["packageManager", { packageManager: "pnpm@9" }],
    ["jest config", { jest: { setupFiles: ["./evil.js"] } }],
    ["eslintConfig", { eslintConfig: { extends: "./evil.js" } }],
    ["babel", { babel: { presets: ["./evil.js"] } }],
    ["mocha", { mocha: { require: ["./evil.js"] } }],
    ["nyc", { nyc: {} }],
    ["prettier", { prettier: "./evil.js" }],
    ["ava", { ava: {} }],
    ["scripts", { scripts: { test: "evil" } }],
    ["an unknown key", { somethingNew: 1 }],
    ["dependenciesMeta", { dependenciesMeta: {} }],
  ])("risky: %s", (_n, change) => expect(risk(change), _n).toBeDefined());
  it("removing a risky key is also a change", () => {
    const withMain = { ...base, main: "index.js" };
    expect(packageJsonRisk(pkg(withMain), pkg(base))).toBeDefined();
  });
  it("an untouched risky key is fine", () => {
    const withMain = { ...base, main: "index.js", exports: "./index.js" };
    expect(packageJsonRisk(pkg(withMain), pkg({ ...withMain, version: "2.0.0" }))).toBeUndefined();
  });
  it("a harmless dep added alongside an existing file: dep is fine only if the existing one is unchanged", () => {
    const withFile = { ...base, dependencies: { zod: "^3", local: "file:../local" } };
    expect(packageJsonRisk(pkg(withFile), pkg({ ...withFile, dependencies: { ...withFile.dependencies, lodash: "^4" } }))).toBeUndefined();
    expect(packageJsonRisk(pkg(withFile), pkg({ ...withFile, dependencies: { ...withFile.dependencies, local: "file:../other" } }))).toBeDefined();
  });
  describe("installs after any package.json edit this session ask", () => {
    const changed = { packageJsonChanged: true };
    it.each(["npm install", "npm i", "npm ci", "npm add x", "npm update", "npm up", "npm upgrade", "npm rebuild", "npm install zod", "npm i -D vitest", "pnpm install", "pnpm i", "pnpm add x", "pnpm update", "yarn install", "yarn add x", "yarn upgrade", "yarn up", "NPM INSTALL", "npm isntall"])(
      "asks: %s",
      (c) => expect(v(c, changed), c).toBe("ask"),
    );
    it("without the flag the same commands are not hard-refused", () => {
      for (const c of ["npm install", "npm ci", "pnpm install", "yarn add x"]) expect(v(c), c).not.toBe("ask");
    });
    it("tests, builds and read-only package commands still work after an edit", () => {
      expect(v("npm test", changed)).toBe("allow");
      expect(v("npm ls", changed)).toBe("allow");
      expect(v("npm outdated", changed)).toBe("allow");
    });
    it("an install chained after something harmless still asks", () => {
      expect(v("git status && npm install", changed)).toBe("ask");
      expect(v("npm install && npm test", changed)).toBe("ask");
    });
  });
});

describe("#52.4 pushd / chdir / Set-Location track the working directory", () => {
  const SUB = new Proxy({} as PolicyContext, { get: (_t, k) => (ctx() as never)[k] });
  it.each([
    "pushd sub && node run.js",
    "pushd sub; node run.js",
    "chdir sub && node run.js",
    "cd sub && node run.js",
    "cd /d sub && node run.js",
    "Set-Location sub; node run.js",
    "Set-Location sub && node run.js",
    "sl sub; node run.js",
    "pushd ./sub && node ./run.js",
  ])("the rest of the line is judged in the new folder (written file there asks): %s", (c) => {
    expect(checkCommand(c, root, SUB).verdict, c).toBe("ask");
  });
  it.each(["pushd .. && ls", "pushd / && ls", "Set-Location .. ; ls", "sl .. ; ls", "chdir .. && ls", "pushd /etc && ls", "Set-Location C:\\Windows ; dir", "pushd ~ && ls"])(
    "leaving the workspace asks: %s",
    (c) => expect(checkCommand(c, root, SUB).verdict, c).toBe("ask"),
  );
  it("popd chained with other commands asks", () => {
    expect(checkCommand("pushd sub && ls && popd", root, SUB).verdict).toBe("ask");
    expect(checkCommand("popd && node run.js", root, SUB).verdict).toBe("ask");
    expect(checkCommand("ls; popd", root, SUB).verdict).toBe("ask");
  });
  it("a harmless chain in a subfolder is still fine", () => {
    expect(checkCommand("pushd sub && ls", root, SUB).verdict).not.toBe("ask");
    expect(checkCommand("Set-Location sub; Get-ChildItem", root, SUB).verdict).not.toBe("ask");
  });
  it("directory commands with a missing, odd or non-string target do not crash", () => {
    for (const c of ["pushd", "cd", "Set-Location", "sl", "chdir", "pushd ''", "cd \"\"", "pushd -", "cd -"]) {
      expect(() => checkCommand(c, root, SUB), c).not.toThrow();
    }
  });
});

describe("#52.5 git fetch argument limits", () => {
  it.each(["git fetch", "git fetch --all", "git fetch --prune", "git fetch -p", "git fetch --tags", "git fetch -t", "git fetch -a", "git fetch origin", "git fetch origin main", "git fetch upstream feature-x", "git fetch --all --prune"])(
    "allowed: %s",
    (c) => expect(v(c), c).toBe("allow"),
  );
  it.each([
    "git fetch http://evil.test/r",
    "git fetch https://evil.test/r.git",
    "git fetch ssh://x@evil.test/r",
    "git fetch git@evil.test:r.git",
    "git fetch ext::sh -c evil",
    "git fetch 'ext::sh -c evil'",
    "git fetch file:///etc",
    "git fetch ::",
    "git fetch +main:main",
    "git fetch origin +refs/heads/*:refs/heads/*",
    "git fetch origin main:main",
    "git fetch --update-head-ok origin main:main",
    "git fetch -u origin",
    "git fetch --force origin",
    "git fetch -f origin",
    "git fetch --upload-pack=evil origin",
    "git fetch --upload-pack evil origin",
    "git fetch origin --upload-pack=evil",
    "git fetch -c core.sshCommand=evil origin",
    "git -c core.sshCommand=evil fetch",
    "GIT FETCH http://evil.test/r",
  ])("not allowed outright: %s", (c) => expect(v(c), c).not.toBe("allow"));
});

describe("#52.6 deploy / release / clean-named scripts are not auto-allowed", () => {
  const scripts: Record<string, string> = {
    deploy: "node scripts/deploy.js",
    release: "node release.js",
    clean: "node scripts/clean.js",
    publish: "npm publish",
    prepublish: "node x.js",
    start: "node server.js",
    dev: "vite",
    gen: "node gen.js",
    typecheck: "tsc --noEmit",
  };
  const sc = { written: new Set<string>(), scriptBody: (nm: string) => scripts[nm] };
  it.each(["deploy", "release", "clean", "start", "dev", "gen"])("npm run %s goes to the classifier, not allow", (nm) => {
    expect(checkCommand(`npm run ${nm}`, root, sc).verdict, nm).toBe("classify");
  });
  it("a script whose body hits a hard rule asks", () => {
    expect(checkCommand("npm run publish", root, sc).verdict).toBe("ask");
  });
  it("a script with a safe body is allowed whatever its name", () => {
    expect(checkCommand("npm run typecheck", root, sc).verdict).toBe("allow");
  });
  it("names that merely contain deploy/release/clean/publish words are not trusted blindly", () => {
    const s2 = { written: new Set<string>(), scriptBody: (nm: string) => ({ "pre-deploy": "node x.js", "release:dry": "node r.js", "clean:all": "node c.js" })[nm] };
    for (const nm of ["pre-deploy", "release:dry", "clean:all"]) expect(checkCommand(`npm run ${nm}`, root, s2).verdict, nm).toBe("classify");
  });
});
