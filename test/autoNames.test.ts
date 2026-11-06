import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCommand, type PolicyContext } from "../src/team/autoPolicy";

/** #53: scripts and files with risky-sounding names (whole-word match) go to the classifier; look-alikes do not. */
let root: string;
const FILES = [
  "deploy.js", "scripts/release.mjs", "cleanAll.js", "db-reset.py", "db_migrate.py", "seed.js", "rollback.ts", "prod.js", "production.js", "destroy.py", "publish.mjs", "Deploy.JS", "DEPLOY.js",
  "deployment.js", "migrations.py", "releases.js",
  "products.js", "cleanup-css.mjs", "seedling.ts", "build.js", "check.py", "dropdown.tsx", "production-ready-check.txt".replace(".txt", ".js") , "producer.js", "proddy.js", "unreleased.js",
  "scripts/gen.js", "main.py", "tools/lint.mjs",
];
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "names-")));
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x");
  }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const ctx = (scripts: Record<string, string> = {}): PolicyContext => ({
  written: new Set(),
  freshFile: () => false,
  scriptBody: (n) => scripts[n],
});
const v = (c: string, scripts?: Record<string, string>) => checkCommand(c, root, ctx(scripts)).verdict;

describe("existing files with risky whole-word names classify", () => {
  it.each(["deploy.js", "scripts/release.mjs", "cleanAll.js", "db-reset.py", "db_migrate.py", "seed.js", "rollback.ts", "prod.js", "production.js", "destroy.py", "publish.mjs", "Deploy.JS", "deployment.js", "migrations.py", "releases.js"])(
    "node/python %s -> classify",
    (f) => {
      const runner = f.endsWith(".py") ? "python" : "node";
      expect(v(`${runner} ${f}`), f).toBe("classify");
    },
  );
  it("also with ./ prefixes, Windows separators and python3/py", () => {
    expect(v("node ./deploy.js")).toBe("classify");
    // Windows separators: classify under cmd; under sh the backslash is an escape, which asks (stricter).
    if (process.platform === "win32") expect(v("node scripts\\release.mjs")).toBe("classify");
    else expect(v("node scripts\\release.mjs")).toBe("ask");
    expect(v("python3 db-reset.py")).toBe("classify");
    expect(v("py db-reset.py")).toBe("classify");
    expect(v("PYTHON db-reset.py")).toBe("classify");
  });
  it("directory names count: a risky word anywhere in the path classifies", () => {
    fs.mkdirSync(path.join(root, "deploy"), { recursive: true });
    fs.writeFileSync(path.join(root, "deploy", "run.js"), "x");
    expect(v("node deploy/run.js")).toBe("classify");
  });
});

describe("look-alike names are not caught (whole words only)", () => {
  it.each(["products.js", "cleanup-css.mjs", "seedling.ts", "build.js", "check.py", "producer.js", "proddy.js", "unreleased.js", "scripts/gen.js", "main.py", "tools/lint.mjs"])("%s -> allow", (f) => {
    const runner = f.endsWith(".py") ? "python" : "node";
    expect(["allow", "classify"], f).toContain(v(`${runner} ${f}`));
    if (!/seed|ing\.ts/.test(f) || f.endsWith(".mjs") || f.endsWith(".js") || f.endsWith(".py")) expect(v(`${runner} ${f}`), f).toBe("allow");
  });
  it("dropdown.tsx is not a node-runnable extension, so it never reaches the allow rule", () => {
    expect(v("node dropdown.tsx")).not.toBe("allow");
  });
});

describe("package scripts with risky names classify, with the body attached", () => {
  const bodies: Record<string, string> = {
    deploy: "tsc --noEmit",
    release: "tsc --noEmit",
    "db:reset": "tsc --noEmit",
    "clean-all": "tsc --noEmit",
    cleanAll: "tsc --noEmit",
    "prod:build": "tsc --noEmit",
    migrate: "tsc --noEmit",
    cleanup: "tsc --noEmit",
    seedling: "tsc --noEmit",
    products: "tsc --noEmit",
    typecheck: "tsc --noEmit",
    check: "tsc --noEmit",
    test: "vitest run",
  };
  it.each(["deploy", "release", "db:reset", "clean-all", "cleanAll", "prod:build", "migrate"])("npm run %s -> classify even though its body is allowed", (nm) => {
    const r = checkCommand(`npm run ${nm}`, root, ctx(bodies));
    expect(r.verdict, nm).toBe("classify");
    if (r.verdict === "classify") expect(r.scriptBody).toBe("tsc --noEmit");
  });
  it.each(["cleanup", "seedling", "products", "typecheck", "check"])("npm run %s -> allow (look-alike or ordinary name)", (nm) => {
    expect(checkCommand(`npm run ${nm}`, root, ctx(bodies)).verdict, nm).toBe("allow");
  });
  it("pnpm and yarn behave the same", () => {
    expect(checkCommand("pnpm run deploy", root, ctx(bodies)).verdict).toBe("classify");
    expect(checkCommand("yarn deploy", root, ctx(bodies)).verdict).not.toBe("allow");
    expect(checkCommand("pnpm run typecheck", root, ctx(bodies)).verdict).toBe("allow");
  });
  it("a risky-named script with a dangerous body still asks (the hard rule wins over classify)", () => {
    expect(checkCommand("npm run deploy", root, ctx({ deploy: "npm publish" })).verdict).toBe("ask");
    expect(checkCommand("npm run clean", root, ctx({ clean: "rm -rf dist" })).verdict).toBe("ask");
  });
  it("npm test is judged the same way by its script name (test is not risky)", () => {
    expect(checkCommand("npm test", root, ctx(bodies)).verdict).toBe("allow");
  });
  it("a chained risky-named script makes the whole line classify, never allow", () => {
    expect(checkCommand("npm test && npm run deploy", root, ctx(bodies)).verdict).toBe("classify");
  });
});

describe("bare vitest needs run / --run / --watch=false", () => {
  it.each(["vitest", "npx vitest", "vitest src", "npx vitest src/a.test.ts"])("classify: %s", (c) => expect(v(c), c).toBe("classify"));
  it.each(["vitest run", "npx vitest run", "npx vitest run a.ts", "vitest --run", "vitest --watch=false", "npx vitest --run a.ts"])("allow: %s", (c) => expect(v(c), c).toBe("allow"));
  it.each(["vitest run --watch", "vitest run -w", "vitest --watch", "npx vitest watch", "vitest dev"])("watch forms are never allowed outright: %s", (c) => expect(v(c), c).not.toBe("allow"));
});

it("vitest --watch=false is explicit non-watch and allows", () => {
  expect(v("vitest --watch=false")).toBe("allow");
});

describe("watch and dev flags classify for every allowlisted build tool", () => {
  const TOOLS = ["tsc", "npx tsc", "vitest run", "npx vitest run", "eslint .", "npx eslint .", "vite build", "npx vite build", "jest", "npx jest", "webpack", "rollup -c", "esbuild src/a.ts --bundle", "tsup", "prettier --check ."];
  const FLAGS = ["--watch", "--watch=true", "-w", "--watchAll", "--serve", "--dev", "--hot", "--open"];
  for (const tool of TOOLS) {
    it.each(FLAGS)(`${tool} %s is not allowed outright`, (f) => {
      expect(v(`${tool} ${f}`), `${tool} ${f}`).not.toBe("allow");
    });
  }
  it.each(["npx vite", "vite dev", "npx next dev", "npx astro dev", "npx webpack serve", "npm run dev", "npm start", "npx serve"])("dev/serve/start words: %s", (c) => {
    expect(v(c), c).not.toBe("allow");
  });
  it("the same tools without the flags are still allowed", () => {
    for (const c of ["tsc --noEmit", "npx vitest run", "npx eslint src", "vite build", "npx jest --ci"]) expect(v(c), c).toBe("allow");
  });
});
