import * as fs from "node:fs";
import * as nodePath from "node:path";

export class PathError extends Error {}

function isInside(root: string, target: string): boolean {
  const rel = nodePath.relative(root, target);
  if (rel === "") return true;
  const escapes = rel === ".." || rel.startsWith(".." + nodePath.sep);
  return !escapes && !nodePath.isAbsolute(rel);
}

/** Nearest existing ancestor (or the path itself), with symlinks resolved. */
function realpathOfExisting(p: string, depth = 0): string {
  let current = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return nodePath.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      // A dangling symlink fails realpath; follow it by hand so a link to a not-yet-existing
      // file outside the root is not mistaken for a new file inside the root.
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          if (depth > 32) throw new PathError("too many levels of symbolic links");
          const dest = nodePath.resolve(nodePath.dirname(current), fs.readlinkSync(current));
          return nodePath.join(realpathOfExisting(dest, depth + 1), ...rest.reverse());
        }
      } catch (e) {
        if (e instanceof PathError) throw e;
      }
      const parent = nodePath.dirname(current);
      if (parent === current) return p;
      rest.push(nodePath.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a model-supplied path against the workspace root and refuse anything
 * that lands outside it, including through symlinks. Returns an absolute path.
 */
export function confinePath(root: string, input: string): string {
  if (!input || input.includes("\0")) throw new PathError("invalid path");
  const absRoot = nodePath.resolve(root);
  const target = nodePath.resolve(absRoot, input);
  if (!isInside(absRoot, target)) {
    throw new PathError(`path is outside the workspace: ${input}`);
  }
  const realRoot = realpathOfExisting(absRoot);
  const realTarget = realpathOfExisting(target);
  if (!isInside(realRoot, realTarget)) {
    throw new PathError(`path resolves outside the workspace (symlink): ${input}`);
  }
  return target;
}

/** Workspace-relative path with forward slashes, for showing to the model and user. */
export function displayPath(root: string, abs: string): string {
  return nodePath.relative(root, abs).split(nodePath.sep).join("/") || ".";
}
