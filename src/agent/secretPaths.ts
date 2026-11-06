// vscode-free helpers: judge a path by both its given form and where it really points (symlinks, junctions).
import * as fs from "node:fs";
import { isSecretPath, isSensitivePath } from "../team/autoPolicy";

/** Resolved real path; the path itself when it doesn't exist or can't be resolved. */
export function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** True if the path or the file it resolves to is a secret file. */
export function isSecretEither(abs: string, root: string): boolean {
  if (isSecretPath(abs, root)) return true;
  const real = realOrSelf(abs);
  return real !== abs && isSecretPath(real, root);
}

/**
 * The path to hand to Team.authorize: the given path if it is itself sensitive/secret, otherwise the resolved path
 * when it differs (so a harmless-looking symlink to .env is judged by its target).
 */
export function pathForAuthorize(abs: string, root: string): string {
  if (isSecretPath(abs, root) || isSensitivePath(abs, root)) return abs;
  return realOrSelf(abs);
}
