import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confinePath, displayPath, PathError } from "../src/agent/paths";

const isWin = process.platform === "win32";

let base: string; // holds root, root-evil and outside
let root: string;
let outside: string;

function tryLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, isWin ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function otherDrive(): string {
  const rootDrive = path.parse(root).root[0].toUpperCase();
  return rootDrive === "D" ? "E" : "D";
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-paths-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(base, "root-evil"));
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("confinePath: accepted paths", () => {
  it("resolves a plain relative file", () => {
    expect(confinePath(root, "a.txt")).toBe(path.join(root, "a.txt"));
  });

  it("allows a file that does not exist yet", () => {
    expect(confinePath(root, "new.txt")).toBe(path.join(root, "new.txt"));
  });

  it("allows a nested path in folders that do not exist yet", () => {
    expect(confinePath(root, "x/y/z/new.txt")).toBe(path.join(root, "x", "y", "z", "new.txt"));
  });

  it("maps '.' to the root", () => {
    expect(confinePath(root, ".")).toBe(root);
  });

  it("allows ./ prefix and inner .. that stays inside", () => {
    expect(confinePath(root, "./sub/../a.txt")).toBe(path.join(root, "a.txt"));
  });

  it("allows an absolute path inside the root", () => {
    const p = path.join(root, "sub", "f.txt");
    expect(confinePath(root, p)).toBe(p);
  });

  it("allows the root given as an absolute path", () => {
    expect(confinePath(root, root)).toBe(root);
  });

  it("accepts a trailing separator on the root argument", () => {
    expect(confinePath(root + path.sep, "a.txt")).toBe(path.join(root, "a.txt"));
  });

  it("allows file names that merely start with two dots", () => {
    expect(confinePath(root, "..hidden")).toBe(path.join(root, "..hidden"));
    expect(confinePath(root, "sub/..foo/bar")).toBe(path.join(root, "sub", "..foo", "bar"));
  });
});

describe("confinePath: rejected paths", () => {
  it("rejects ..", () => {
    expect(() => confinePath(root, "..")).toThrow(PathError);
  });

  it("rejects ../x and ../../x", () => {
    expect(() => confinePath(root, "../x")).toThrow(PathError);
    expect(() => confinePath(root, "../../x")).toThrow(PathError);
  });

  it("rejects a/../../x", () => {
    expect(() => confinePath(root, "a/../../x")).toThrow(PathError);
  });

  it("rejects escaping through a nonexistent folder", () => {
    expect(() => confinePath(root, "nope/../../outside/secret.txt")).toThrow(PathError);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => confinePath(root, path.join(outside, "secret.txt"))).toThrow(PathError);
  });

  it("rejects the parent of the root", () => {
    expect(() => confinePath(root, base)).toThrow(PathError);
  });

  it("rejects a sibling directory whose name starts with the root name", () => {
    expect(() => confinePath(root, path.join(base, "root-evil", "f.txt"))).toThrow(PathError);
    expect(() => confinePath(root, "../root-evil/f.txt")).toThrow(PathError);
    expect(() => confinePath(root, path.join(base, "root-evil"))).toThrow(PathError);
  });

  it("rejects NUL bytes", () => {
    expect(() => confinePath(root, "a\0.txt")).toThrow(PathError);
    expect(() => confinePath(root, "\0")).toThrow(PathError);
  });

  it("rejects the empty string", () => {
    expect(() => confinePath(root, "")).toThrow(PathError);
  });

  it("includes the offending input in the error", () => {
    expect(() => confinePath(root, "../zzz")).toThrow(/zzz/);
  });
});

describe.runIf(isWin)("confinePath: Windows specifics", () => {
  it("rejects backslash traversal", () => {
    expect(() => confinePath(root, "..\\x")).toThrow(PathError);
    expect(() => confinePath(root, "sub\\..\\..\\x")).toThrow(PathError);
  });

  it("accepts backslash separators inside the root", () => {
    expect(confinePath(root, "sub\\f.txt")).toBe(path.join(root, "sub", "f.txt"));
  });

  it("rejects a different drive", () => {
    const other = otherDrive();
    expect(() => confinePath(root, `${other}:\\x`)).toThrow(PathError);
    expect(() => confinePath(root, `${other}:/x/y.txt`)).toThrow(PathError);
  });

  it("rejects a drive-relative path to another drive", () => {
    expect(() => confinePath(root, `${otherDrive()}:x`)).toThrow(PathError);
  });

  it("rejects a UNC path", () => {
    expect(() => confinePath(root, "\\\\server\\share\\x")).toThrow(PathError);
  });

  it("rejects the root of the current drive", () => {
    expect(() => confinePath(root, path.parse(root).root)).toThrow(PathError);
    expect(() => confinePath(root, "\\")).toThrow(PathError);
  });

  it("treats drive-letter case as the same drive", () => {
    const c = root[0];
    const flipped = (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + root.slice(1);
    expect(confinePath(root, path.join(flipped, "a.txt")).toLowerCase()).toBe(
      path.join(root, "a.txt").toLowerCase(),
    );
  });

  it("is case-insensitive for the root folder name but still rejects outside paths", () => {
    const upper = path.join(base, "ROOT", "a.txt");
    expect(confinePath(root, upper).toLowerCase()).toBe(path.join(root, "a.txt").toLowerCase());
    expect(() => confinePath(root, path.join(base, "ROOT-EVIL", "a.txt"))).toThrow(PathError);
  });

  it("works when the root is given in forward-slash form", () => {
    const fwd = root.replace(/\\/g, "/");
    expect(confinePath(fwd, "a.txt")).toBe(path.join(root, "a.txt"));
    expect(() => confinePath(fwd, "../x")).toThrow(PathError);
  });
});

describe.skipIf(isWin)("confinePath: POSIX specifics", () => {
  it("rejects absolute paths like /etc/passwd", () => {
    expect(() => confinePath(root, "/etc/passwd")).toThrow(PathError);
  });

  it("treats backslashes as ordinary file name characters", () => {
    expect(confinePath(root, "a\\b")).toBe(path.join(root, "a\\b"));
  });
});

describe("confinePath: symlinks and junctions", () => {
  let linkOut: string;
  let linkIn: string;
  let created = false;

  beforeAll(() => {
    linkOut = path.join(root, "link-out");
    linkIn = path.join(root, "link-in");
    created = tryLink(outside, linkOut);
    if (created) tryLink(path.join(root, "sub"), linkIn);
    if (!created) console.warn("symlink/junction creation failed; link tests skipped");
  });

  it("rejects a path through a link that points outside", (ctx) => {
    if (!created) return ctx.skip();
    expect(() => confinePath(root, "link-out/secret.txt")).toThrow(PathError);
  });

  it("rejects the link itself", (ctx) => {
    if (!created) return ctx.skip();
    expect(() => confinePath(root, "link-out")).toThrow(PathError);
  });

  it("rejects a not-yet-existing file below an outside link", (ctx) => {
    if (!created) return ctx.skip();
    expect(() => confinePath(root, "link-out/new/dir/file.txt")).toThrow(PathError);
  });

  it("rejects an absolute path through the outside link", (ctx) => {
    if (!created) return ctx.skip();
    expect(() => confinePath(root, path.join(linkOut, "secret.txt"))).toThrow(PathError);
  });

  it("allows a link that points to another place inside the root", (ctx) => {
    if (!created || !fs.existsSync(linkIn)) return ctx.skip();
    expect(confinePath(root, "link-in/new.txt")).toBe(path.join(root, "link-in", "new.txt"));
  });

  // [qa -> host] paths.ts: a dangling link whose target is outside the root used to pass, because realpath
  // fails on it and the code fell back to the link's parent folder.
  it("rejects a dangling link that points outside the root", (ctx) => {
    const missing = path.join(outside, "does-not-exist-yet");
    const dangling = path.join(root, "dangling");
    if (!tryLink(missing, dangling)) return ctx.skip();
    expect(() => confinePath(root, "dangling")).toThrow(PathError);
    expect(() => confinePath(root, "dangling/child.txt")).toThrow(PathError);
  });

  it("rejects a dangling file symlink that points outside the root", (ctx) => {
    const dangling = path.join(root, "dangling-file");
    try {
      fs.symlinkSync(path.join(outside, "nope.txt"), dangling, "file");
    } catch {
      return ctx.skip();
    }
    expect(() => confinePath(root, "dangling-file")).toThrow(PathError);
  });

  it("allows a dangling link that points inside the root", (ctx) => {
    const dangling = path.join(root, "dangling-in");
    if (!tryLink(path.join(root, "not-created-yet"), dangling)) return ctx.skip();
    expect(confinePath(root, "dangling-in")).toBe(dangling);
  });

  it("works when the root itself is reached through a link", (ctx) => {
    if (!created) return ctx.skip();
    const rootLink = path.join(base, "root-link");
    if (!tryLink(root, rootLink)) return ctx.skip();
    expect(confinePath(rootLink, "a.txt")).toBe(path.join(rootLink, "a.txt"));
    expect(() => confinePath(rootLink, "link-out/secret.txt")).toThrow(PathError);
    expect(() => confinePath(rootLink, "../outside/secret.txt")).toThrow(PathError);
  });
});

describe("displayPath", () => {
  it("returns a forward-slash relative path", () => {
    expect(displayPath(root, path.join(root, "sub", "f.txt"))).toBe("sub/f.txt");
  });

  it("returns '.' for the root", () => {
    expect(displayPath(root, root)).toBe(".");
  });

  it("returns a single name for a top-level file", () => {
    expect(displayPath(root, path.join(root, "a.txt"))).toBe("a.txt");
  });
});
