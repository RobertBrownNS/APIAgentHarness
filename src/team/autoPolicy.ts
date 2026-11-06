// Auto-mode rules. Pure: no vscode or SDK imports, so they can be unit-tested directly.
// Allowlist-first: a command is auto-allowed only if it is a recognised safe command with no expansion tricks.
// Hard rules and anything suspicious -> "ask". Everything else -> "classify" (the model-based safety check).
// The classifier can only turn "classify" into allow/ask; it never overrides "ask".
import * as fs from "node:fs";
import * as path from "node:path";

export interface PolicyContext {
  /** Absolute paths written or edited this session, normalised with normalizePath(). */
  written: ReadonlySet<string>;
  /** Body of a package.json script, if known. */
  scriptBody?: (name: string, dir?: string) => string | undefined;
  /** True if the file was created or changed since the team started (by any means, e.g. a shell redirect or a build). */
  freshFile?: (absPath: string) => boolean;
  /** True once package.json was edited this session (even harmlessly): installs then ask because they run lifecycle scripts. */
  packageJsonChanged?: boolean;
  /** Shell that will run the command; defaults to cmd on Windows and sh elsewhere (how run_command spawns). */
  shell?: ShellKind;
}

export type CommandVerdict =
  | { verdict: "allow"; rule: string }
  | { verdict: "classify"; scriptBody?: string }
  | { verdict: "ask"; rule: string };
export type EditVerdict = { verdict: "ask"; rule: string } | { verdict: "allow" };

/** Hard cap only to bound the policy's own work; long commands are judged like any other. */
const MAX_COMMAND_CHARS = 100_000;
/** The safety check reads at most this much (src/agent/classifier.ts); longer commands can't be judged by it. */
const CLASSIFIER_CHARS = 4000;
const MAX_SCRIPT_DEPTH = 3;

// ---- paths ----

/** Case-folded, forward-slash, absolute form used to compare paths on Windows and POSIX. */
export function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isInside(p: string, root: string): boolean {
  const a = normalizePath(path.resolve(root, p));
  const r = normalizePath(root);
  return a === r || a.startsWith(`${r}/`);
}

/** Strip the tricks Windows ignores: trailing dots and spaces on a segment, and the ::$DATA stream suffix. */
function cleanSegment(seg: string): string {
  return seg.replace(/::\$[a-z_]+$/i, "").replace(/[. ]+$/, "").toLowerCase();
}

const KEY_EXT = /\.(pem|key|pfx|p12)$/;
const SCRIPT_EXT = /\.(sh|bat|cmd|ps1)$/;

/** Files an agent should not change without the user: always asks in Auto and is never covered by "approve all". */
export function isSensitivePath(absPath: string, root: string): boolean {
  void root;
  const parts = absPath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(cleanSegment);
  if (!parts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if ([".git", ".ssh", ".vscode", ".husky", ".claude", ".cursor", ".devcontainer"].includes(p)) return true;
    if (/~\d/.test(p)) return true; // 8.3 short name: can't tell what it points at
    if (p === ".github" && parts[i + 1] === "workflows") return true;
    if (p === "node_modules" && parts[i + 1] === ".bin") return true;
  }
  const base = parts[parts.length - 1];
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    KEY_EXT.test(base) ||
    base.startsWith("id_rsa") ||
    base === ".npmrc" ||
    base.startsWith(".yarnrc") ||
    base === ".pypirc" ||
    base === ".mcp.json" ||
    base === ".gitattributes" ||
    base === ".gitmodules" ||
    base === "makefile" ||
    base === "gnumakefile" ||
    SCRIPT_EXT.test(base)
  );
}

const SECRET_DIRS = new Set([".ssh", ".aws", ".kube", ".docker", ".gnupg", ".azure", ".config/gcloud"]);
const NON_SECRET_ENV = /^\.env\.(example|sample|template|dist)$/;

/** Does this path (or path-like token) name a file that holds credentials? Reading it always asks. */
/** bash-style brace expansion of one token, e.g. .{env,ssh/config} -> .env, .ssh/config. Returns undefined if too large. */
function braceExpand(token: string, limit = 64): string[] | undefined {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/s.exec(token);
  if (!m) return [token];
  const [, pre, body, post] = m;
  let alts: string[];
  const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body) ?? /^([A-Za-z])\.\.([A-Za-z])$/.exec(body);
  if (range) {
    const num = /\d/.test(range[1]);
    const a = num ? Number(range[1]) : range[1].charCodeAt(0);
    const b = num ? Number(range[2]) : range[2].charCodeAt(0);
    if (Math.abs(b - a) > limit) return undefined;
    alts = [];
    for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) alts.push(num ? String(i) : String.fromCharCode(i));
  } else if (body.includes(",")) {
    alts = body.split(",");
  } else {
    return [token];
  }
  const out: string[] = [];
  for (const alt of alts) {
    const sub = braceExpand(pre + alt + post, limit);
    if (!sub) return undefined;
    out.push(...sub);
    if (out.length > limit) return undefined;
  }
  return out;
}

/** Expand a simple glob in the last path segment against the real folder and check for secret files. */
function globTouchesSecret(token: string, cwd: string): boolean {
  const norm = token.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  const dirPart = slash >= 0 ? norm.slice(0, slash) : ".";
  const pat = slash >= 0 ? norm.slice(slash + 1) : norm;
  if (/[*?[]/.test(dirPart)) return true; // glob in a folder name: can't tell
  let re: RegExp;
  try {
    let src = "";
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === "*") src += ".*";
      else if (c === "?") src += ".";
      else if (c === "[") {
        const end = pat.indexOf("]", i + 1);
        if (end < 0) src += "\\[";
        else {
          src += `[${pat.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
          i = end;
        }
      } else src += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    re = new RegExp(`^${src}$`, "i");
  } catch {
    return true;
  }
  let names: string[];
  try {
    names = fs.readdirSync(path.resolve(cwd, dirPart));
  } catch {
    return false;
  }
  return names.some((n) => re.test(n) && isSecretFile(n));
}

function isSecretFile(token: string): boolean {
  const parts = token.replace(/\\/g, "/").split("/").filter(Boolean).map(cleanSegment);
  const base = parts[parts.length - 1] ?? "";
  if (parts.some((p) => SECRET_DIRS.has(p))) return true;
  if (base.endsWith(".pub")) return false; // public keys are not secret
  if (NON_SECRET_ENV.test(base)) return false;
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    KEY_EXT.test(base) ||
    /^id_[a-z0-9]+/.test(base) ||
    base === ".npmrc" ||
    base === ".pypirc" ||
    base.startsWith(".yarnrc") ||
    base === ".netrc" ||
    base === "_netrc" ||
    base === ".git-credentials" ||
    base === ".pgpass" ||
    base === ".htpasswd" ||
    /\.(kdbx|tfstate|tfvars|keystore|jks|ovpn)$/.test(base) ||
    /\.tfstate\.backup$/.test(base) ||
    /^credentials?(\.|$)/.test(base) ||
    /^secrets?(\.|$)/.test(base) ||
    base.includes("service-account") ||
    base.includes("service_account")
  );
}

/** Files that hold credentials: reading them (read_file, search_text, list_files, cat ...) always asks, in every mode. */
export function isSecretPath(absPath: string, root: string): boolean {
  void root;
  return typeof absPath === "string" && isSecretFile(absPath);
}

// True if a glob names secret files explicitly (such as .env files, *.pem or .ssh folders). A missing glob returns false.
export function globNamesSecrets(glob: string | undefined): boolean {
  if (!glob) return false;
  const g = glob.replace(/\\/g, "/").toLowerCase();
  return /(^|[/{,])\.env|\.(pem|key|pfx|p12)\b|id_[a-z0-9]+|(^|[/{,])\.(ssh|aws|kube|docker|gnupg|azure)|\.npmrc|\.pypirc|\.yarnrc|[._]netrc|\.(keystore|jks|ovpn)\b|git-credentials|\.pgpass|\.htpasswd|\.(kdbx|tfstate|tfvars)\b|credentials|secrets?\b|service[-_]account/.test(g);
}

/** Edits are allowed inside the workspace except for sensitive paths. */
export function checkEdit(absPath: string, root: string): EditVerdict {
  if (typeof absPath !== "string" || !absPath.trim()) return { verdict: "ask", rule: "no path" };
  if (!isInside(absPath, root)) return { verdict: "ask", rule: "path is outside the workspace" };
  if (isSensitivePath(absPath, root)) return { verdict: "ask", rule: "sensitive file or folder" };
  return { verdict: "allow" };
}

// ---- hard rules ----

interface Rule {
  name: string;
  re: RegExp;
}

// Applied to every segment (after splitting on ; && || | & and newlines).
const SEGMENT_RULES: Rule[] = [
  { name: "recursive delete (rm -r)", re: /\brm\b[^\n]*\s(-[a-z]*r[a-z]*|--recursive)(\s|$)/i },
  { name: "recursive delete (rmdir/rd/del /s)", re: /\b(rmdir|rd|del|erase)\b[^\n]*\s\/s\b/i },
  { name: "recursive delete (Remove-Item -Recurse)", re: /\b(remove-item|ri|rm|del|erase|rd|rmdir)\b[^\n]*\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?:\s|$|:)/i },
  { name: "creating a link (ln/mklink)", re: /(^|[\s;&|(`])(ln|mklink)(\s|$)/i },
  { name: "creating a link (New-Item -ItemType)", re: /\b(new-item|ni)\b[^\n]*-(itemtype|type)\s+(symboliclink|hardlink|junction)\b/i },
  { name: "creating a link (fsutil hardlink)", re: /\bfsutil\b[^\n]*\bhardlink\b/i },
  { name: "xargs rm", re: /\bxargs\b[^\n]*\b(rm|del|rmdir)\b/i },
  { name: "rsync --delete", re: /\brsync\b[^\n]*--delete/i },
  { name: "robocopy /mir or /purge", re: /\brobocopy\b[^\n]*\s\/(mir|purge)\b/i },
  { name: "download tool", re: /\b(certutil\b[^\n]*-urlcache|bitsadmin|start-bitstransfer)\b/i },
  { name: "network transfer (scp/nc)", re: /(^|[\s;&|(`])(scp|nc|ncat|netcat)(\s|$)/i },
  { name: "iex / Invoke-Expression", re: /(^|[\s;&|(`])(iex|invoke-expression)(\s|$|\()/i },
  { name: "encoded command", re: /(^|\s)-(encodedcommand|enc|ec)(\s|$)/i },
  { name: "sudo / runas", re: /(^|[\s;&|(`])(sudo|runas|doas)(\s|$)/i },
  { name: "recursive chmod/chown", re: /\b(chmod|chown|chgrp)\b[^\n]*\s(-[a-z]*r[a-z]*|--recursive)(\s|$)/i },
  { name: "publishing a package", re: /\b(npm|pnpm|yarn)\b[^\n]*\bpublish\b/i },
  { name: "publishing a package (cargo publish)", re: /\bcargo\b[^\n]*\bpublish\b/i },
  { name: "publishing a package (twine upload)", re: /\btwine\b[^\n]*\bupload\b/i },
  { name: "publishing a package (nuget push)", re: /\bdotnet\b[^\n]*\bnuget\b[^\n]*\bpush\b/i },
  { name: "global install", re: /\b(npm|pnpm|yarn|pip|pip3|cargo)\b[^\n]*\s(-g|--global)(\s|$)/i },
  { name: "global install (yarn global)", re: /\byarn\s+global\b/i },
  { name: "docker --privileged", re: /\bdocker\b[^\n]*--privileged\b/i },
  {
    name: "redirection into a sensitive path",
    re: />>?\s*['"]?[^\s'"]*(\.env\b|\.pem\b|\.key\b|\.pfx\b|\.p12\b|id_rsa|\.ssh[\\/]|\.npmrc\b|\.git[\\/]|\.vscode[\\/]|package\.json\b|\.husky[\\/]|\.github[\\/]workflows|node_modules[\\/]\.bin)/i,
  },
  { name: "home directory (~)", re: /(^|[\s='":(])~([\\/]|\s|$)/ },
  // Home-directory variables ($HOME, %USERPROFILE%) are covered by the shell-aware expansion check, which runs first;
  // matching them here as text would also catch harmless literal mentions (single quotes, $HOME under cmd.exe).
];

// Whole-line rules: they span a pipe, so they run before the line is split.
const LINE_RULES: Rule[] = [
  {
    name: "piping a download into a shell",
    re: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|iex|invoke-expression|pwsh|powershell)\b/i,
  },
  {
    name: "pipe into an interpreter",
    re: /\|\s*(?:sudo\s+|env\s+)?(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd|node|deno|bun|python3?|py|perl|ruby|php|lua|osascript|iex|invoke-expression)(?:\.exe)?(?:\s+-[A-Za-z-]+)*\s*(?:$|[|;&)]|\s-(?:\s|$))/i,
  },
  { name: "base64 -d piped", re: /\bbase64\b[^\n]*(-d|--decode|-D)\b[^\n]*\|/i },
];

const DANGEROUS_FIRST_WORDS = new Set([
  "su", "format", "mkfs", "dd", "diskpart", "shutdown", "reboot", "halt", "poweroff", "setx",
  "set-executionpolicy", "runas", "sudo", "doas", "iex", "invoke-expression", "ln", "mklink",
]);

const TOP_DIRS = new Set([
  "etc", "usr", "bin", "sbin", "var", "opt", "root", "home", "tmp", "dev", "proc", "sys", "mnt", "lib", "lib64",
  "boot", "srv", "users", "windows", "applications", "system", "library", "volumes", "private",
]);
const SAFE_ABSOLUTE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin"]);

function unbalancedQuotes(cmd: string): boolean {
  let q = "";
  for (const c of cmd) {
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") {
      q = c;
    }
  }
  return q !== "";
}

/** Split on ; && || | & ( ) backticks and newlines. A `&` that is part of a redirect (2>&1, &>) is not a separator. */
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    // Separators inside quotes are data ("a; b"); $ and backticks inside quotes already ask elsewhere.
    if (quote) {
      if (c === quote) quote = "";
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const redirectAmp =
      (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">" || cmd[i - 1] === "<")) || (c === "|" && cmd[i - 1] === ">");
    if (!redirectAmp && (c === ";" || c === "&" || c === "|" || c === "\n" || c === "\r" || c === "(" || c === ")" || c === "`")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split into words, honouring simple quotes (quotes are removed). */
function tokenize(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  let has = false;
  for (const c of seg) {
    if (quote) {
      if (c === quote) quote = "";
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

function baseWord(t: string): string {
  return t.replace(/^['"]|['"]$/g, "").replace(/\.(exe|com|cmd|bat)$/i, "").replace(/^.*[\\/]/, "").toLowerCase();
}

function firstWord(seg: string): string {
  for (const t of seg.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // VAR=value prefix
    if (t === "call" || t === "start" || t === "command" || t === "exec" || t === "time" || t === "nohup") continue;
    return baseWord(t);
  }
  return "";
}

function outsideWorkspacePath(seg: string, root: string): string | undefined {
  for (const m of seg.matchAll(/(^|[\s='"(,])([A-Za-z]:[\\/][^\s'"`;|&<>]*|\\\\[^\s'"`;|&<>]+)/g)) {
    const p = m[2];
    if (p.startsWith("\\\\") || !isInside(p, root)) return p;
  }
  // POSIX absolute paths. Skip URLs ("https://...") and single-letter switches such as cmd's /s.
  for (const m of seg.matchAll(/(^|[\s='"(,])(\/[^\s'"`;|&<>]*)/g)) {
    const p = m[2];
    if (p.startsWith("//") || SAFE_ABSOLUTE.has(p)) continue;
    const parts = p.split("/").filter(Boolean);
    if (parts.length === 0) return p;
    if (parts.length === 1 && !TOP_DIRS.has(parts[0].toLowerCase())) continue;
    if (!isInside(p, root)) return p;
  }
  return undefined;
}

const seqCache = new Map<Rule, RegExp[] | null>();

/**
 * Does the rule match? A rule written as `A[^\n]*B[^\n]*C` is checked as "A, then later B, then later C" with one
 * forward scan per part. That is equivalent (the earliest match of each part is the best choice) but linear, where the
 * single backtracking regex is quadratic on input like "rm rm rm ...".
 */
function ruleMatches(r: Rule, text: string): boolean {
  let parts = seqCache.get(r);
  if (parts === undefined) {
    const src = r.re.source;
    try {
      parts = src.includes("[^\\n]*") ? src.split("[^\\n]*").map((p) => new RegExp(p, r.re.flags.replace(/[gy]/g, ""))) : null;
    } catch {
      parts = null; // a part is not a valid regex on its own (the split cut through a group): use the whole rule
    }
    seqCache.set(r, parts);
  }
  if (!parts) return r.re.test(text);
  let rest = text;
  for (const part of parts) {
    const m = part.exec(rest);
    if (!m) return false;
    rest = rest.slice(m.index + m[0].length);
  }
  return true;
}

/** Hard rules on one command string. Returns the rule that fired. */
function hardRule(cmd: string, root: string): string | undefined {
  for (const line of cmd.split(/\r?\n/)) {
    for (const r of LINE_RULES) if (ruleMatches(r, line)) return r.name;
  }
  for (const seg of splitSegments(cmd)) {
    const word = firstWord(seg);
    if (DANGEROUS_FIRST_WORDS.has(word) || /^mkfs\./.test(word)) return `command "${word}"`;
    if (word === "reg" && /\breg(\.exe)?\s+(add|delete)\b/i.test(seg)) return "registry change (reg add/delete)";
    for (const r of SEGMENT_RULES) if (ruleMatches(r, seg)) return r.name;
    const outside = outsideWorkspacePath(seg, root);
    if (outside) return `path outside the workspace (${outside.slice(0, 60)})`;
  }
  return undefined;
}

// ---- expansion and escapes ----

/** The shell run_command uses: cmd.exe on Windows, /bin/sh elsewhere (spawn with shell: true). */
export type ShellKind = "cmd" | "posix" | "both";
// On Windows spawn uses %ComSpec%; if that is not cmd.exe, apply both cmd's and POSIX's expansion rules.
const DEFAULT_SHELL: ShellKind =
  process.platform === "win32"
    ? path.basename(process.env.ComSpec ?? "cmd.exe").toLowerCase() === "cmd.exe"
      ? "cmd"
      : "both"
    : "posix";

/**
 * Expansion the shell that actually runs the command would perform. Only real expansion counts:
 * cmd.exe treats `$` and backticks as plain text, and sh never expands inside single quotes.
 */
function expansionIn(cmd: string, shell: ShellKind = DEFAULT_SHELL): string | undefined {
  if (/[A-Za-z0-9_](""|'')[A-Za-z0-9_]/.test(cmd)) return "quote-splitting in a word";
  if (shell === "both") return expansionIn(cmd, "cmd") ?? expansionIn(cmd, "posix");
  if (shell === "cmd") {
    // cmd expands %VAR% even inside double quotes (names may contain parentheses: %ProgramFiles(x86)%);
    // ^ escapes (r^m) are only special outside them.
    if (/%[A-Za-z_][A-Za-z0-9_()]*(:[^%]*)?%/.test(cmd)) return "variable expansion (%VAR%)";
    let inDouble = false;
    for (const ch of cmd) {
      if (ch === '"') inDouble = !inDouble;
      else if (ch === "^" && !inDouble) return "escape character (^)";
    }
    return undefined;
  }
  // POSIX sh: $NAME, ${…}, $(…) and backticks expand outside single quotes (also inside double quotes).
  // Special parameters like $1, $?, $$ only produce short values, so they don't count.
  let q: "" | "'" | '"' = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = "";
      continue;
    }
    if (ch === "\\") {
      const next = cmd[i + 1];
      // Outside quotes a backslash can spell a name (.\env -> .env). Inside double quotes it only escapes $ ` " \ and newline.
      // Escaping a special character (\$ \" \\) just yields that character; escaping a name character spells a name.
      if (q === "" && next !== undefined && /[A-Za-z0-9_.\-/~]/.test(next)) return "backslash escape";
      i++; // an escaped character is literal
      continue;
    }
    if (ch === "$" && q === "" && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) return "ANSI-C or locale quoting ($'...')";
    if (ch === "'" && q === "") q = "'";
    else if (ch === '"') q = q === '"' ? "" : '"';
    else if (ch === "`") return "shell expansion (backtick)";
    else if (ch === "$" && /[A-Za-z_{(]/.test(cmd[i + 1] ?? "")) return "shell expansion ($)";
  }
  return undefined;
}

function stripBenignRedirects(seg: string): string {
  return seg
    .replace(/&>\s*(\/dev\/null|nul)\b/gi, " ")
    .replace(/(^|\s)[12]?>>?\s*(\/dev\/null|nul)\b/gi, " ")
    .replace(/\b[12]>&[12]\b/g, " ");
}

// ---- allowlist ----

const WRITERS = new Set([
  "mkdir", "md", "tee", "set-content", "add-content", "out-file", "cp", "copy", "mv", "move", "sed", "rm", "del", "erase", "ren", "rename",
  "xcopy", "robocopy", "ni", "new-item", "sc", "ac", "install", "ln", "mklink",
]);
const RUNNER_WORDS = new Set([
  "tsc", "vitest", "eslint", "prettier", "pytest", "jest", "mocha", "esbuild", "tsup", "webpack", "rollup", "ruff", "mypy",
  "vite", "next", "astro", "svelte-kit", "black", "gradle", "gradlew", "mvn", "mvnw",
]);
const READER_CMDLETS = new Set(["get-content", "gc", "select-string", "sls", "get-childitem", "gci", "select-object", "measure-object", "sort-object", "where-object", "test-path", "get-location", "get-command", "gcm", "where", "which"]);
const READ_ONLY = new Set(["ls", "dir", "cat", "type", "head", "tail", "rg", "grep", "find", "wc", "pwd", "echo", "findstr"]);
const GIT_SAFE = new Set(["status", "diff", "log", "show", "add", "commit", "rev-parse"]);

/** Skip git's global options and return the subcommand and its arguments. */
function gitParts(tokens: string[]): { sub: string; args: string[]; hasDashC: boolean } {
  let hasDashC = false;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const t = tokens[i];
    if (t === "-c") hasDashC = true;
    const takesArg = t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace" || t === "--exec-path";
    i += takesArg ? 2 : 1;
  }
  return { sub: (tokens[i] ?? "").toLowerCase(), args: tokens.slice(i + 1), hasDashC };
}

function namesWrittenFile(tokens: string[], root: string, written: ReadonlySet<string>): boolean {
  if (written.size === 0) return false;
  for (const t of tokens.slice(1)) {
    if (!t) continue;
    if (t.startsWith("-") && !t.includes("=")) continue;
    const v = t.includes("=") ? t.slice(t.indexOf("=") + 1) : t;
    if (written.has(normalizePath(path.resolve(root, v)))) return true;
  }
  return false;
}

/** Scripts and files with names like these change or destroy things; they go to the classifier even if they exist already. */
const DESTRUCTIVE_WORDS = new Set([
  "deploy", "release", "publish", "clean", "reset", "migrate", "seed", "drop", "destroy", "rollback", "prod",
  "production", "deployment", "migration", "migrations", "releases", "deploys", "rollbacks",
]);
const DESTRUCTIVE_NAME = {
  /** Whole words only: split on non-alphanumerics and camelCase, so deploy.js and db:reset match but products.js and dropdown.tsx do not. */
  test(name: string): boolean {
    const words = name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase());
    return words.some((w) => DESTRUCTIVE_WORDS.has(w));
  },
};

const MODULE_SUFFIXES = ["", ".py", ".js", ".mjs", ".cjs", ".ts", ".json"];

/**
 * Option values given to a runner or script (`--config x`, `-p mod`, `--setupFiles=x`) can be code. Ask if one names
 * a file written or created this session; module names (pytest -p mod) are tried with common extensions.
 */
function optionValueUntrusted(tokens: string[], start: number, cwd: string, ctx: PolicyContext): boolean {
  if (ctx.written.size === 0 && !ctx.freshFile) return false;
  const bad = (v: string | undefined): boolean => {
    if (!v) return false;
    for (const suf of MODULE_SUFFIXES) {
      const abs = path.resolve(cwd, v + suf);
      if (ctx.written.has(normalizePath(abs)) || ctx.freshFile?.(abs)) return true;
    }
    const asPath = path.resolve(cwd, v.replace(/\./g, "/") + ".py");
    return ctx.written.has(normalizePath(asPath)) || !!ctx.freshFile?.(asPath);
  };
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      if (t.includes("=")) {
        if (bad(t.slice(t.indexOf("=") + 1))) return true;
      } else if (tokens[i + 1] && !tokens[i + 1].startsWith("-") && bad(tokens[i + 1])) {
        return true;
      }
    }
  }
  return false;
}

const CODE_OPTIONS = new Set(["--config", "-c", "--require", "-r", "--import", "--loader", "--setup", "--setupfiles", "--preset", "--plugin", "--rulesdir", "--resolve-plugins-relative-to", "--parser", "--globalsetup", "--reporter", "--environment", "--root", "--project", "-p", "--rootdir"]);

function runnerOptionNamesWritten(tokens: string[], cwd: string, written: ReadonlySet<string>): boolean {
  if (written.size === 0) return false;
  const hit = (v: string | undefined) => !!v && written.has(normalizePath(path.resolve(cwd, v)));
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("-")) continue;
    if (t.includes("=")) {
      if (hit(t.slice(t.indexOf("=") + 1))) return true;
    } else if (CODE_OPTIONS.has(t.toLowerCase()) && hit(tokens[i + 1])) {
      return true;
    }
  }
  return false;
}

const WATCH_FLAGS = new Set(["--watch", "-w", "--watchall", "--serve", "--dev", "--hot", "watch", "serve", "dev", "start", "--open"]);

/**
 * Build, test and lint tools that are safe to run without asking (they run the project's own code, like `npm test`).
 * Returns the rule name, or undefined if this is not one of them (or it looks like a dev server / watcher / deploy).
 */
function buildToolRule(word: string, a: string[]): string | undefined {
  const first = a.find((x) => !x.startsWith("-")) ?? "";
  const watching = a.some((x) => WATCH_FLAGS.has(x.toLowerCase()) && x.toLowerCase() !== "--watch=false") || a.some((x) => /^--watch=(?!false$)/i.test(x));
  // A watcher or dev server never exits and would just burn the command timeout.
  if (watching) return undefined;
  switch (word) {
    case "tsc":
    case "eslint":
      return word;
    case "vitest":
      // Bare `vitest` starts a watcher in a terminal: require an explicit single run.
      return first === "run" || a.includes("--run") || a.some((x) => x.toLowerCase() === "--watch=false") ? word : undefined;
    case "jest":
    case "mocha":
    case "esbuild":
    case "tsup":
    case "webpack":
    case "rollup":
    case "ruff":
    case "mypy":
      return watching ? undefined : word;
    case "vite":
      return first === "build" ? "vite build" : undefined;
    case "next":
      return first === "build" || first === "lint" ? `next ${first}` : undefined;
    case "astro":
      return first === "build" || first === "check" ? `astro ${first}` : undefined;
    case "svelte-kit":
      return first === "sync" || first === "build" ? `svelte-kit ${first}` : undefined;
    case "black":
      return a.includes("--check") ? "black --check" : undefined;
    case "prettier":
      return a.includes("--check") ? "prettier --check" : undefined;
    case "gradle":
    case "gradlew":
    case "mvn":
    case "mvnw": {
      if (a.some((x) => ["publish", "deploy", "install", "release", "upload"].includes(x.toLowerCase()))) return undefined;
      return ["test", "build", "check", "verify", "compile", "package", "assemble", "classes"].includes(first.toLowerCase()) ? `${word} ${first}` : undefined;
    }
    default:
      return undefined;
  }
}

type SegVerdict = { v: "allow"; rule: string } | { v: "classify"; scriptBody?: string } | { v: "ask"; rule: string };

const SHELL_WORDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "eval", "source"]);

/**
 * If the segment starts with wrapper commands, return the command they run (tokens), "ask" for eval / xargs sh,
 * or undefined when there is no wrapper.
 */
function unwrapCommand(tokens: string[], strict = true): string[] | "ask" | undefined {
  let i = 0;
  let changed = false;
  const isVar = (x: string | undefined) => !!x && /^[A-Za-z_][A-Za-z0-9_]*=/.test(x);
  for (let guard = 0; guard < 8 && i < tokens.length; guard++) {
    while (isVar(tokens[i])) {
      i++;
      changed = true;
    }
    const w = baseWord(tokens[i] ?? "");
    if (w === "eval") {
      if (strict) return "ask";
      i++;
      changed = true;
      continue;
    }
    if (["command", "nohup", "time", "exec", "setsid", "builtin", "busybox"].includes(w)) {
      i++;
      changed = true;
    } else if (w === "env") {
      i++;
      changed = true;
      while (i < tokens.length && (tokens[i].startsWith("-") || isVar(tokens[i]))) i += ["-u", "-C", "-S", "--unset", "--chdir"].includes(tokens[i]) ? 2 : 1;
    } else if (w === "timeout") {
      i++;
      changed = true;
      while (i < tokens.length && tokens[i].startsWith("-")) i += ["-s", "-k", "--signal", "--kill-after"].includes(tokens[i]) ? 2 : 1;
      i++; // the duration
    } else if (w === "nice") {
      i++;
      changed = true;
      while (i < tokens.length && tokens[i].startsWith("-")) i += tokens[i] === "-n" ? 2 : 1;
    } else if (w === "ionice") {
      i++;
      changed = true;
      while (i < tokens.length && tokens[i].startsWith("-")) i += ["-c", "-n", "-p", "-P", "-u"].includes(tokens[i]) ? 2 : 1;
    } else if (w === "stdbuf") {
      i++;
      changed = true;
      while (i < tokens.length && tokens[i].startsWith("-")) i += /^-[ioe]$/.test(tokens[i]) ? 2 : 1;
    } else if (w === "xargs") {
      i++;
      changed = true;
      while (i < tokens.length && tokens[i].startsWith("-")) i += ["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a"].includes(tokens[i]) ? 2 : 1;
      if (strict && SHELL_WORDS.has(baseWord(tokens[i] ?? ""))) return "ask";
    } else {
      break;
    }
  }
  if (!changed) return undefined;
  const rest = tokens.slice(i);
  if (rest.length === 0) return undefined;
  if (strict && SHELL_WORDS.has(baseWord(rest[0]))) return "ask";
  return rest;
}

function judgeSegment(seg: string, root: string, ctx: PolicyContext, depth: number, cwd: string = root): SegVerdict {
  const cleaned = stripBenignRedirects(seg).trim();
  const rawTokens = tokenize(cleaned);
  if (rawTokens.length === 0) return { v: "allow", rule: "empty" };
  const rawFirst = cleaned.split(/\s+/)[0] ?? "";
  if (/['"]/.test(rawFirst)) return { v: "ask", rule: "quoted command name" };
  if (rawFirst.includes("\\") && !/^([A-Za-z]:|\.\\|\\\\)/.test(rawFirst)) return { v: "ask", rule: "backslash inside the command name" };
  if (rawFirst.includes("{")) return { v: "ask", rule: "brace expansion in the command name" };

  // bash expands {a,b} and {1..3} before the command runs: every later check sees the expanded words.
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const tk = rawTokens[i];
    if (!/\{[^{}]*(,|\.\.)[^{}]*\}/.test(tk)) {
      tokens.push(tk);
      continue;
    }
    const alts = braceExpand(tk);
    if (!alts) return { v: "ask", rule: "large brace expansion" };
    // `--config {a,b}.js`: judge every alternative as that option's value, not only the first.
    const prev = rawTokens[i - 1];
    if (prev && prev.startsWith("-") && !prev.includes("=") && alts.length > 1) {
      tokens.pop();
      for (const alt of alts) tokens.push(prev, alt);
    } else {
      tokens.push(...alts);
    }
  }

  // Wrapper commands (env, command, nohup, time, timeout, nice, stdbuf, setsid, exec, xargs) run what follows: judge that instead.
  const unwrapped = unwrapCommand(tokens);
  if (unwrapped === "ask") return { v: "ask", rule: "eval or a wrapper that runs a shell" };
  if (unwrapped) {
    const rest = unwrapped.join(" ");
    const hard = hardRule(rest, root);
    if (hard) return { v: "ask", rule: hard };
    return judgeSegment(rest, root, ctx, depth + 1, cwd);
  }

  // Skip VAR=value prefixes for the command word.
  let ci = 0;
  while (ci < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[ci])) ci++;
  const t = tokens.slice(ci);
  const word = baseWord(t[0] ?? "");
  const args = t.slice(1);
  const lowerArgs = args.map((a) => a.toLowerCase());

  // An interpreter reading its program from stdin or a file redirect, or sourcing a file, runs unreviewed code.
  const INTERPRETERS = ["sh", "bash", "zsh", "dash", "ksh", "fish", "node", "deno", "bun", "python", "python3", "py", "perl", "ruby", "php", "lua", "osascript", "pwsh", "powershell", "cmd", "iex"];
  if (INTERPRETERS.includes(word) && /</.test(cleaned)) return { v: "ask", rule: `${word} reads code from a redirect` };
  if (INTERPRETERS.includes(word) && args.length > 0 && args.every((a) => a === "-" || a === "-s")) {
    return { v: "ask", rule: `${word} reads code from stdin` };
  }
  if (word === "source" || t[0] === ".") return { v: "ask", rule: "sourcing a file runs its code" };

  // Inline-code interpreters run arbitrary code.
  if (word === "powershell" || word === "pwsh") return { v: "ask", rule: "PowerShell runs arbitrary code" };
  if (["bash", "sh", "zsh", "dash", "ksh"].includes(word) && args.some((a) => /^-[a-z]*c[a-z]*$/i.test(a))) {
    return { v: "ask", rule: "shell -c runs arbitrary code" };
  }
  if (word === "cmd" && lowerArgs.some((a) => a === "/c" || a === "/k")) return { v: "ask", rule: "cmd /c runs arbitrary code" };
  if (word === "node" && lowerArgs.some((a) => ["-e", "--eval", "-p", "--print"].includes(a))) {
    return { v: "ask", rule: "node -e runs inline code" };
  }
  if (["python", "python3", "py"].includes(word) && lowerArgs.includes("-c")) return { v: "ask", rule: "python -c runs inline code" };
  if (word === "perl" && lowerArgs.some((a) => a === "-e")) return { v: "ask", rule: "perl -e runs inline code" };
  if (word === "ruby" && lowerArgs.includes("-e")) return { v: "ask", rule: "ruby -e runs inline code" };

  // Paths that leave the workspace.
  for (const a of t.slice(1)) {
    // `..` is fine while the resolved path stays inside the workspace (src/../README.md, ../x after cd sub).
    const dd = a.startsWith("-") && a.includes("=") ? a.slice(a.indexOf("=") + 1) : a;
    if (dd.split(/[\\/]/).includes("..") && !isInside(path.resolve(cwd, dd), root)) {
      return { v: "ask", rule: "path leaves the workspace (..)" };
    }
    if (/^~/.test(a)) return { v: "ask", rule: "home directory (~)" };
    const val = a.includes("=") ? a.slice(a.indexOf("=") + 1) : a;
    if (/^\/[A-Za-z?]$/.test(a)) continue; // cmd-style switch such as /s (a bare argument, not an option value)
    if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(val) && !SAFE_ABSOLUTE.has(val) && !isInside(val, root)) {
      return { v: "ask", rule: "path outside the workspace" };
    }
  }

  // A glob that matches a secrets file in the folder is a secrets read (cat .e*, type id_*, grep x cred*).
  if (t.slice(1).some((a) => /[*?[]/.test(a) && globTouchesSecret(a, cwd))) return { v: "ask", rule: "glob matches a secrets file" };
  if (word === "rg" && lowerArgs.some((a) => a === "--hidden" || a === "--no-ignore" || a.startsWith("--no-ignore-") || /^-u+$/.test(a) || a === "--unrestricted")) {
    return { v: "ask", rule: "rg searches hidden or ignored files" };
  }
  // Reading credentials into the conversation is not something to do silently.
  if (t.slice(1).some((a) => isSecretFile(a))) return { v: "ask", rule: "touches a secrets file" };

  if (WRITERS.has(word) && t.slice(1).some((a) => !a.startsWith("-") && isSensitivePath(path.resolve(cwd, a), root))) {
    return { v: "ask", rule: "writes a sensitive path" };
  }

  // A script or program created this session by any means (shell redirect, download, build) is unreviewed code.
  if (ctx.freshFile && !READ_ONLY.has(word) && word !== "git") {
    const runners = new Set(["node", "deno", "bun", "python", "python3", "py", "ruby", "perl", "php", "lua", "sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "pwsh", "powershell"]);
    const candidates = runners.has(word) ? t.slice(1).filter((a) => !a.startsWith("-")) : [];
    if (/\.(bat|cmd|ps1|sh|exe)$/i.test(t[0] ?? "") || /^\.[\\/]/.test(t[0] ?? "")) candidates.push(t[0]);
    if (candidates.some((a) => ctx.freshFile!(path.resolve(cwd, a)))) return { v: "ask", rule: "runs a file created this session" };
  }

  const hasRedirect = /[<>]/.test(cleaned);
  // Test runners and linters are exempt like npm test: running the project's own tests is the accepted trust level.
  const runner =
    RUNNER_WORDS.has(word) || (word === "npx" && RUNNER_WORDS.has(lowerArgs[0] ?? ""));
  const readOnlyish = READ_ONLY.has(word) || word === "git" || runner || READER_CMDLETS.has(word);
  // A command that names a file written this session may be running it. Read-only utilities and git can't execute it.
  // A runner may run a written test file, but a written config / plugin / loader passed as an option runs as code.
  if (runner && (runnerOptionNamesWritten(t, cwd, ctx.written) || optionValueUntrusted(t, 1, cwd, ctx))) {
    return { v: "ask", rule: "a file written this session is passed as an option" };
  }
  if (!readOnlyish && namesWrittenFile(t, cwd, ctx.written)) return { v: "ask", rule: "runs or reads a file written this session" };

  if (hasRedirect) return { v: "classify" };

  // --- allowlist ---
  if (word === "git") {
    const { sub, args: gargs, hasDashC } = gitParts(t);
    if (hasDashC) return { v: "ask", rule: "git -c can run commands" };
    const lg = gargs.map((a) => a.toLowerCase());
    {
      const afterDashes = gargs.slice(gargs.indexOf("--") + 1);
      const revPaths = gargs.filter((a) => a.includes(":") && !a.startsWith("-")).map((a) => a.slice(a.indexOf(":") + 1));
      if ([...revPaths, ...(gargs.includes("--") ? afterDashes : [])].some((p) => isSecretFile(p))) {
        return { v: "ask", rule: "git reads a secrets file" };
      }
    }
    if (sub === "push") return { v: "ask", rule: "git push" };
    if (sub === "clean") return { v: "ask", rule: "git clean" };
    if (sub === "rebase") return { v: "ask", rule: "git rebase" };
    if (sub === "reset" && lg.includes("--hard")) return { v: "ask", rule: "git reset --hard" };
    if ((sub === "checkout" || sub === "restore") && (gargs.includes(".") || gargs.includes("--"))) {
      return { v: "ask", rule: `git ${sub} discards changes` };
    }
    if (sub === "branch" && gargs.includes("-D")) return { v: "ask", rule: "git branch -D" };
    if (sub === "commit" && lg.includes("--amend")) return { v: "ask", rule: "git commit --amend" };
    if (sub === "stash") {
      const action = gargs[0] && !gargs[0].startsWith("-") ? lg[0] : "push";
      return ["push", "list", "show", "pop", "apply", "save"].includes(action) ? { v: "allow", rule: `git stash ${action}` } : { v: "classify" };
    }
    if (sub === "checkout" && gargs[0] === "-b" && gargs.length >= 2 && gargs.length <= 3 && gargs.slice(1).every((a) => !a.startsWith("-"))) {
      return { v: "allow", rule: "git checkout -b" };
    }
    if (sub === "switch") {
      // Only plain `switch <branch>` and `switch -c <new> [<start>]`; anything that can discard work goes to the classifier.
      const names = gargs.filter((a) => !a.startsWith("-"));
      const flagsOk = lg.every((a) => !a.startsWith("-") || a === "-c" || a === "--create");
      if (flagsOk && names.length >= 1 && names.length <= 2) return { v: "allow", rule: "git switch" };
      return { v: "classify" };
    }
    if (sub === "fetch") {
      const plain = gargs.every((a) => ["--all", "--prune", "-p", "--tags", "-t", "-a"].includes(a.toLowerCase()) || /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(a));
      return plain && !gargs.some((a) => /^[a-z]+:\/\//i.test(a)) ? { v: "allow", rule: "git fetch" } : { v: "classify" };
    }
    if (sub === "restore" && lg.some((a) => a === "--staged" || a === "-S") && !lg.some((a) => ["--worktree", "-w", "--source", "-s"].includes(a) || a.startsWith("--source="))) {
      return { v: "allow", rule: "git restore --staged" };
    }
    if (sub === "branch") {
      const names = gargs.filter((a) => !a.startsWith("-"));
      if (names.length >= 1 && names.length <= 2 && gargs.every((a) => !a.startsWith("-"))) return { v: "allow", rule: "git branch (create)" };
      const listOnly = gargs.every((a) => ["-a", "-r", "-v", "-vv", "--list", "--all", "--remotes", "--show-current", "--verbose"].includes(a));
      return listOnly ? { v: "allow", rule: "git branch (list)" } : { v: "classify" };
    }
    if (GIT_SAFE.has(sub)) {
      if (gargs.some((a) => /^--(output|ext-diff|textconv|upload-pack|exec)/.test(a))) return { v: "classify" };
      if (sub === "commit" && gargs.some((a) => a === "--amend")) return { v: "ask", rule: "git commit --amend" };
      return { v: "allow", rule: `git ${sub}` };
    }
    return { v: "classify" };
  }
  if (READ_ONLY.has(word)) {
    if (word === "find" && lowerArgs.some((a) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(a))) {
      return { v: "ask", rule: "find -delete/-exec" };
    }
    if (word === "rg" && lowerArgs.some((a) => a.startsWith("--pre"))) return { v: "classify" };
    if (word === "grep" && lowerArgs.some((a, i) => a === "--recursive" || a === "--dereference-recursive" || /^-[a-z]*r[a-z]*$/.test(a) || a === "--directories=recurse" || (a === "-d" && lowerArgs[i + 1] === "recurse"))) {
      return { v: "classify" };
    }
    if (word === "findstr" && lowerArgs.includes("/s")) return { v: "classify" };
    return { v: "allow", rule: word };
  }
  if (word === "popd") return { v: "ask", rule: "popd goes back to an unknown folder" };
  if (["cd", "chdir", "pushd", "set-location", "sl"].includes(word)) {
    const target = args.filter((a) => !a.startsWith("/") || a.length > 2).filter((a) => !a.startsWith("-") && a.toLowerCase() !== "/d").pop();
    if (!target) return { v: "classify" };
    const abs = path.resolve(cwd, target);
    return isInside(abs, root) ? { v: "allow", rule: "cd inside the workspace" } : { v: "ask", rule: "cd leaves the workspace" };
  }
  if (word === "mkdir" || word === "md") return { v: "allow", rule: "mkdir inside the workspace" };
  if (word === "new-item" || word === "ni") {
    const ti = lowerArgs.findIndex((a) => a === "-itemtype" || a === "-type");
    return ti >= 0 && lowerArgs[ti + 1] === "directory" ? { v: "allow", rule: "New-Item -ItemType Directory" } : { v: "classify" };
  }
  if (["where", "which", "get-command", "gcm", "get-location", "test-path", "select-object", "measure-object", "sort-object", "where-object", "get-content", "gc", "select-string", "sls"].includes(word)) {
    return { v: "allow", rule: word };
  }
  if (word === "get-childitem" || word === "gci") {
    return lowerArgs.some((a) => a === "-recurse" || a === "-r" || a === "-rec") ? { v: "classify" } : { v: "allow", rule: "Get-ChildItem" };
  }
  if (["node", "python", "python3", "py"].includes(word) && args[0] && !args[0].startsWith("-") && /\.(c?m?js|py|ts)$/i.test(args[0]) && ctx.freshFile) {
    const abs = path.resolve(cwd, args[0]);
    if (args.some((a) => !a.startsWith("-") && DESTRUCTIVE_NAME.test(a))) return { v: "classify" }; // any folder or file name in the path
    if (isInside(abs, root) && !isSensitivePath(abs, root) && !ctx.written.has(normalizePath(abs)) && !ctx.freshFile(abs)) {
      try {
        if (fs.statSync(abs).isFile()) return { v: "allow", rule: `${word} <existing file>` };
      } catch {
        /* missing: let the classifier decide */
      }
    }
    return { v: "classify" };
  }
  if ((word === "node" || word === "python" || word === "python3") && lowerArgs.length === 1 && ["--version", "-v"].includes(lowerArgs[0])) {
    return { v: "allow", rule: `${word} --version` };
  }
  if (word === "pytest") return { v: "allow", rule: "pytest" };
  if ((word === "python" || word === "python3") && lowerArgs[0] === "-m" && lowerArgs[1] === "pytest") return { v: "allow", rule: "pytest" };
  if (word === "cargo" && ["build", "test", "check"].includes(lowerArgs[0] ?? "")) return { v: "allow", rule: `cargo ${lowerArgs[0]}` };
  if (word === "go" && ["build", "test", "vet"].includes(lowerArgs[0] ?? "")) return { v: "allow", rule: `go ${lowerArgs[0]}` };
  if (word === "dotnet" && ["build", "test"].includes(lowerArgs[0] ?? "")) return { v: "allow", rule: `dotnet ${lowerArgs[0]}` };
  // Bare binaries as they appear in package.json scripts (node_modules/.bin is on the PATH there).
  {
    const rule = buildToolRule(word, lowerArgs);
    if (rule) return { v: "allow", rule };
  }
  if (word === "npx") {
    const rule = buildToolRule(lowerArgs[0] ?? "", lowerArgs.slice(1));
    return rule ? { v: "allow", rule: `npx ${rule}` } : { v: "classify" };
  }
  if (word === "npm" || word === "pnpm" || word === "yarn") {
    // --prefix / --dir / -C / --cwd <dir>: the package in that folder
    let dir: string | undefined;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (["--prefix", "--dir", "-C", "--cwd"].includes(a)) {
        dir = args[i + 1];
        i++;
      } else if (/^--(prefix|dir|cwd)=/.test(a)) {
        dir = a.slice(a.indexOf("=") + 1);
      } else {
        rest.push(a);
      }
    }
    let pkgCwd = cwd;
    if (dir !== undefined) {
      pkgCwd = path.resolve(cwd, dir);
      if (!dir || !isInside(pkgCwd, root)) return { v: "ask", rule: "package folder is outside the workspace" };
    }
    const lr = rest.map((a) => a.toLowerCase());
    if (ctx.packageJsonChanged && ["install", "i", "ci", "add", "update", "up", "upgrade", "rebuild", "isntall"].includes(lr[0] ?? "")) {
      return { v: "ask", rule: "package.json was edited this session; installing runs lifecycle scripts" };
    }
    const readOnly = word === "npm" ? ["ls", "list", "outdated", "view", "explain", "why", "root"] : word === "pnpm" ? ["ls", "list", "outdated", "why"] : ["list", "outdated", "why", "info"];
    if (lr.length > 0 && readOnly.includes(lr[0]) && !lr.includes("-g") && !lr.includes("--global")) {
      return { v: "allow", rule: `${word} ${lr[0]}` };
    }
    return judgeScript(word, lr, rest, root, ctx, depth, pkgCwd);
  }
  return { v: "classify" };
}

/** npm|pnpm|yarn test / run <script>: check the script body itself, recursively. */
function judgeScript(pm: string, lowerArgs: string[], args: string[], root: string, ctx: PolicyContext, depth: number, cwd: string = root): SegVerdict {
  let name: string | undefined;
  if (lowerArgs[0] === "test" || lowerArgs[0] === "t") name = "test";
  else if (lowerArgs[0] === "run" || lowerArgs[0] === "run-script") name = args[1];
  else return { v: "classify" };
  if (!name || name.startsWith("-")) return { v: "classify" };
  if (ctx.written.has(normalizePath(path.resolve(cwd, "package.json")))) {
    return { v: "ask", rule: "package.json was changed this session" };
  }
  if (optionValueUntrusted(args, 2, cwd, ctx)) return { v: "ask", rule: "a file created this session is passed to the script as an option" };
  const body = ctx.scriptBody?.(name, cwd);
  if (body === undefined || depth >= MAX_SCRIPT_DEPTH) return { v: "classify" };
  const inner = judge(body, root, ctx, depth + 1, cwd);
  if (inner.verdict === "ask") return { v: "ask", rule: `script "${name}": ${inner.rule}` };
  if (DESTRUCTIVE_NAME.test(name)) return { v: "classify", scriptBody: body };
  if (inner.verdict === "allow") return { v: "allow", rule: `${pm} ${name} (script is safe)` };
  return { v: "classify", scriptBody: body };
}

function judge(command: string, root: string, ctx: PolicyContext, depth: number, cwd0: string = root): CommandVerdict {
  let cwd = cwd0;
  if (typeof command !== "string") return { verdict: "ask", rule: "command is not text" };
  // Fold lookalike characters and drop invisible ones so they can't hide a keyword.
  command = command.normalize("NFKC").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "");
  if (command.length > MAX_COMMAND_CHARS) return { verdict: "ask", rule: `command is longer than ${MAX_COMMAND_CHARS} characters` };
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(command)) return { verdict: "ask", rule: "control characters in the command" };
  if (splitSegments(command).length > 40) return { verdict: "ask", rule: "too many chained commands" };
  if (command.length > MAX_COMMAND_CHARS) return { verdict: "ask", rule: `command is longer than ${MAX_COMMAND_CHARS} characters` };
  if (!command.trim()) return { verdict: "ask", rule: "empty command" };
  const exp = expansionIn(command, ctx.shell);
  if (exp) return { verdict: "ask", rule: exp };
  if (unbalancedQuotes(command)) return { verdict: "ask", rule: "unbalanced quotes" };
  if ((command.match(/\{/g) ?? []).length !== (command.match(/\}/g) ?? []).length) return { verdict: "ask", rule: "unbalanced braces" };
  // bash expands {a,b} / {1..3} before running: a command name built from braces asks, and everything else is judged expanded.
  if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(command)) {
    if (splitSegments(command).some((s) => (s.trim().split(/\s+/)[0] ?? "").includes("{"))) {
      return { verdict: "ask", rule: "brace expansion in the command name" };
    }
    let tooBig = false;
    command = command.replace(/\S+/g, (w, offset: number, whole: string) => {
      if (!/\{[^{}]*(,|\.\.)[^{}]*\}/.test(w)) return w;
      const alts = braceExpand(w);
      if (!alts) {
        tooBig = true;
        return w;
      }
      // `--config {a,b}.js`: judge every alternative as that option's value, not only the first.
      const prev = whole.slice(0, offset).trimEnd().split(/\s+/).pop() ?? "";
      if (prev.startsWith("-") && !prev.includes("=") && alts.length > 1) {
        return [alts[0], ...alts.slice(1).map((a) => `${prev} ${a}`)].join(" ");
      }
      return alts.join(" ");
    });
    if (tooBig) return { verdict: "ask", rule: "large brace expansion" };
  }
  const hard = hardRule(command, root);
  if (hard) return { verdict: "ask", rule: hard };

  let allowRule = "";
  let classify = false;
  let scriptBody: string | undefined;
  for (const seg of splitSegments(command)) {
    const r = judgeSegment(seg, root, ctx, depth, cwd);
    // "cd <dir> && rest": the following segments run in that folder.
    if (r.v === "allow" && r.rule === "cd inside the workspace") {
      const target = tokenize(seg).slice(1).filter((a) => a.toLowerCase() !== "/d").pop();
      if (target) cwd = path.resolve(cwd, target);
    }
    if (r.v === "ask") return { verdict: "ask", rule: r.rule };
    if (r.v === "classify") {
      classify = true;
      scriptBody ??= r.scriptBody;
    } else if (!allowRule) {
      allowRule = r.rule;
    }
  }
  if (classify) return { verdict: "classify", ...(scriptBody !== undefined ? { scriptBody } : {}) };
  return { verdict: "allow", rule: allowRule || "allowlisted" };
}

/**
 * Auto-mode rules for run_command. `allow` = recognised safe command; `classify` = hand to the safety check;
 * `ask` = needs the user (hard rule, expansion characters, inline code, a file written this session, ...).
 */
export function checkCommand(command: string, root: string, ctx: PolicyContext = { written: new Set() }): CommandVerdict {
  const r = judge(command, root, ctx, 0);
  // The safety check only sees the first CLASSIFIER_CHARS characters, so it can't vouch for a longer command.
  if (r.verdict === "classify" && typeof command === "string" && command.length > CLASSIFIER_CHARS) {
    return { verdict: "ask", rule: `command is too long for the safety check (${command.length} characters)` };
  }
  return r;
}

/** Files a command is about to create or overwrite (redirects, tee, cp/mv, curl -o, wget -O). For the written-file rule. */
export function writeTargets(command: string, root: string): string[] {
  const out = new Set<string>();
  const add = (t: string | undefined) => {
    if (!t || t.startsWith("-") || t === "/dev/null" || t.toLowerCase() === "nul" || t.startsWith("&")) return;
    out.add(normalizePath(path.resolve(root, t)));
  };
  for (const seg of splitSegments(String(command ?? ""))) {
    const toks = tokenize(seg);
    const word = baseWord(toks[0] ?? "");
    for (let i = 0; i < toks.length; i++) {
      const m = /^(?:\d?>>?|&>>?)(.*)$/.exec(toks[i]);
      if (m) add(m[1] || toks[i + 1]);
    }
    for (const m of seg.matchAll(/(?:^|\s)\d?>>?\s*([^\s<>|&]+)/g)) add(m[1]);
    if (word === "tee" || word === "set-content" || word === "add-content" || word === "out-file") {
      for (const a of toks.slice(1)) add(a);
    }
    if (["cp", "copy", "mv", "move", "xcopy"].includes(word)) add(toks[toks.length - 1]);
    if (word === "curl") {
      for (let i = 1; i < toks.length - 1; i++) if (toks[i] === "-o" || toks[i] === "--output") add(toks[i + 1]);
    }
    if (word === "wget") {
      for (let i = 1; i < toks.length - 1; i++) if (toks[i] === "-O" || toks[i] === "--output-document") add(toks[i + 1]);
    }
  }
  return [...out];
}

const PKG_HARMLESS_KEYS = new Set([
  "name", "version", "description", "keywords", "author", "contributors", "license", "repository", "bugs", "homepage", "private",
  "files", "engines", "os", "cpu", "funding", "displayname", "publisher", "icon", "categories", "gallerybanner", "preview", "sideeffects",
]);
const PKG_DEP_SECTIONS = new Set(["dependencies", "devdependencies", "peerdependencies", "optionaldependencies"]);
/** A dependency specifier that only names a registry version or tag (no URL, path, git or alias). */
const PLAIN_SPEC = /^[A-Za-z0-9^~<>=*.\-+| ]+$/;

/**
 * A package.json change is only risky if it touches fields that run code or install hooks:
 * scripts, bin, husky / lint-staged / simple-git-hooks, any pre* / post* / prepare hook, or config.
 * Returns what was touched, or undefined for a harmless change (dependencies, version, description ...).
 */
export function packageJsonRisk(oldContent: string | undefined, newContent: string): string | undefined {
  let next: Record<string, unknown>;
  try {
    next = JSON.parse(newContent) as Record<string, unknown>;
  } catch {
    return "the result is not valid JSON";
  }
  let prev: Record<string, unknown> = {};
  if (oldContent !== undefined) {
    try {
      prev = JSON.parse(oldContent) as Record<string, unknown>;
    } catch {
      return "the current file is not valid JSON";
    }
  }
  if (typeof next !== "object" || next === null || typeof prev !== "object" || prev === null) return "unexpected structure";
  const keys = new Set<string>([...Object.keys(next), ...Object.keys(prev)]);
  for (const k of keys) {
    if (JSON.stringify(prev[k]) === JSON.stringify(next[k])) continue;
    const lk = k.toLowerCase();
    if (PKG_HARMLESS_KEYS.has(lk)) continue;
    if (PKG_DEP_SECTIONS.has(lk)) {
      const a = (prev[k] ?? {}) as Record<string, unknown>;
      const b = (next[k] ?? {}) as Record<string, unknown>;
      for (const dep of Object.keys(b)) {
        if (JSON.stringify(a[dep]) !== JSON.stringify(b[dep]) && !(typeof b[dep] === "string" && PLAIN_SPEC.test(b[dep] as string))) {
          return `adds dependency "${dep}" with a non-registry source`;
        }
      }
      continue;
    }
    return `changes "${k}"`;
  }
  return undefined;
}

// ---- Ultra mode: a tiny backstop ----

export type UltraVerdict = { verdict: "allow" } | { verdict: "ask"; rule: string };

const ULTRA_DISK_WORDS = new Set([
  "format", "diskpart", "mkfs", "dd", "fdisk", "sfdisk", "parted", "wipefs", "shutdown", "reboot", "halt", "poweroff", "bcdedit",
  "set-executionpolicy", "setx", "sudo", "su", "runas", "doas", "stop-computer", "restart-computer", "format-volume", "clear-disk",
  "remove-partition", "initialize-disk", "regedit", "bootrec", "killall5", "lvremove", "vgremove", "pvremove", "telinit",
]);
const ULTRA_DELETE = new Set(["rm", "rmdir", "rd", "del", "erase", "remove-item", "ri", "unlink", "shred"]);
const ULTRA_MOVE = new Set(["mv", "move", "ren", "rename", "move-item", "mi"]);
const ULTRA_COPY = new Set(["cp", "copy", "xcopy", "rsync", "copy-item", "cpi"]);
const ULTRA_WRITE = new Set(["tee", "set-content", "add-content", "out-file", "sc", "ac", "truncate", "touch", "mkdir", "md", "ni", "new-item", "ln", "mklink", "install"]);
const ULTRA_CHMOD = new Set(["chmod", "chown", "chgrp"]);
const ULTRA_ATTR = new Set(["icacls", "takeown", "attrib", "cipher", "fsutil", "cacls"]);
const CONTROL_WORDS = new Set(["do", "then", "else", "while", "until", "{", "!", "time", "coproc"]);
const CLOSER_WORDS = new Set(["fi", "done", "}", "esac", "in", "for", "case", "select", "function"]);
const EXPANSION_IN_TARGET = /[$`]|%[A-Za-z_(]|^~/;
const REGISTRY_PATH = /^(hk(lm|cu|cr|u|cc)|registry:)/i;
const SECRET_NAME_IN_TEXT =
  /(^|[^\w.-])(\.env(?:\.[\w.-]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|_?\.?netrc|\.git-credentials|\.pgpass|\.htpasswd|\.aws[\\/]credentials|credentials\.json|[\w.-]+\.(?:pem|pfx|p12|key|kdbx|tfstate|tfvars))(?=$|[^\w.-])/gi;
const INLINE_CODE = /\b(node|nodejs|deno|bun)\b[^|;&]*\s(-e|--eval|-p|--print)\b|\b(python3?|py)\b[^|;&]*\s-c\b|\bperl\b[^|;&]*\s-[eE]\b|\bruby\b[^|;&]*\s-e\b|\bphp\b[^|;&]*\s-r\b|\b(powershell|pwsh)\b|\[io\.file\]|\bcmd\b[^|;&]*\s\/[ck]\b/i;

function hasAnsiCQuoting(cmd: string): boolean {
  let q = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = "";
    } else if (ch === "\\") {
      i++;
    } else if (ch === "$" && q === "" && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) {
      return true;
    } else if (ch === "'" && q === "") {
      q = "'";
    } else if (ch === '"') {
      q = q === '"' ? "" : '"';
    }
  }
  return false;
}

/** Expand {a,b} / {1..3} words in a whole command; undefined if an expansion is too large. */
function expandBracesText(command: string): string | undefined {
  if (!/\{[^{}]*(,|\.\.)[^{}]*\}/.test(command)) return command;
  let tooBig = false;
  const out = command.replace(/\S+/g, (w, offset: number, whole: string) => {
    if (!/\{[^{}]*(,|\.\.)[^{}]*\}/.test(w)) return w;
    const alts = braceExpand(w);
    if (!alts) {
      tooBig = true;
      return w;
    }
    const prev = whole.slice(0, offset).trimEnd().split(/\s+/).pop() ?? "";
    if (prev.startsWith("-") && !prev.includes("=") && alts.length > 1) {
      return [alts[0], ...alts.slice(1).map((a) => `${prev} ${a}`)].join(" ");
    }
    return alts.join(" ");
  });
  return tooBig ? undefined : out;
}

/**
 * Pull `$(...)` and `` `...` `` substitutions out of a command: their bodies run too, so they are checked on their own.
 * The outer command keeps a `$SUB` placeholder, which counts as an expansion in any target position.
 */
function peelSubstitutions(cmd: string): { outer: string; inner: string[] } | undefined {
  // sh does not expand inside single quotes: hide those regions while peeling.
  const hidden: string[] = [];
  let masked = "";
  for (let i = 0, dq = false; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\") {
      masked += ch + (cmd[i + 1] ?? "");
      i++;
    } else if (ch === '"') {
      dq = !dq;
      masked += ch;
    } else if (ch === "'" && !dq) {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) {
        masked += cmd.slice(i);
        break;
      }
      hidden.push(cmd.slice(i, end + 1));
      masked += `\uE000${hidden.length - 1}\uE001`;
      i = end;
    } else {
      masked += ch;
    }
  }
  const restore = (s: string) => s.replace(/\uE000(\d+)\uE001/g, (_m, n: string) => hidden[Number(n)] ?? "");
  const r = peelMasked(masked);
  return r && { outer: restore(r.outer), inner: r.inner.map(restore) };
}

function peelMasked(cmd: string): { outer: string; inner: string[] } | undefined {
  const inner: string[] = [];
  let outer = cmd;
  for (let round = 0; round < 8; round++) {
    const before = outer;
    outer = outer
      .replace(/`([^`]*)`/g, (_m, body: string) => {
        inner.push(body);
        return "$SUB";
      })
      .replace(/\$\(([^()]*)\)/g, (_m, body: string) => {
        inner.push(body);
        return "$SUB";
      });
    if (outer === before) return { outer, inner };
  }
  return undefined; // nested too deeply
}

const ultraAsk = (rule: string): UltraVerdict => ({ verdict: "ask", rule });

/** Commands that destroy remote or cloud resources, or hand a container the host's disk. Returns the reason. */
const GLOBAL_VALUE_OPTIONS: Record<string, string[]> = {
  aws: ["--profile", "--region", "--endpoint-url", "--output", "--query", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout"],
  gh: ["-r", "--repo", "--hostname"],
  docker: ["-h", "--host", "--context", "-c", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
  podman: ["-h", "--host", "--connection", "-c", "--url", "--log-level", "--root", "--runroot"],
  nerdctl: ["-h", "--host", "-a", "--address", "-n", "--namespace", "--cgroup-manager"],
  gsutil: ["-o", "-h", "-u"],
  kubectl: ["-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "-s", "--server", "--as"],
  helm: ["-n", "--namespace", "--kube-context", "--kubeconfig"],
};

/** Positional words of a command, skipping global options and their values (`aws --profile p s3 rm ...` -> s3 rm ...). */
function subcommandWords(word: string, lower: string[]): string[] {
  const valueOpts = GLOBAL_VALUE_OPTIONS[word] ?? [];
  const out: string[] = [];
  for (let i = 0; i < lower.length; i++) {
    const a = lower[i];
    if (a.startsWith("-")) {
      if (valueOpts.includes(a) && !a.includes("=")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function cloudDestroyRule(word: string, args: string[], lower: string[]): string | undefined {
  const has = (x: string) => lower.includes(x);
  const sub = subcommandWords(word, lower);
  switch (word) {
    case "terraform":
    case "tofu":
    case "terragrunt":
      if (has("destroy") || lower.some((a) => a === "-destroy" || a === "--destroy" || a.startsWith("-destroy="))) return `${word} destroy`;
      return undefined;
    case "kubectl":
    case "oc":
    case "k3s":
    case "microk8s":
      return has("delete") || sub.includes("delete") ? `${word} delete` : undefined;
    case "helm":
      return has("uninstall") || has("delete") || has("del") ? "helm uninstall" : undefined;
    case "aws":
      if (sub[0] === "s3" && sub[1] === "rb") return "aws s3 rb";
      if (sub[0] === "s3" && sub[1] === "rm" && (has("--recursive") || has("--include") || has("--exclude"))) return "aws s3 rm --recursive";
      if (lower.some((a) => /^(delete|remove|terminate|deregister|destroy|purge|disable)-/.test(a))) return "aws delete/terminate call";
      return undefined;
    case "az":
      return has("delete") ? "az ... delete" : undefined;
    case "gcloud":
    case "gsutil":
      if (has("delete") || sub.includes("delete")) return `${word} delete`;
      if (word === "gsutil" && sub[0] === "rm" && (lower.some((a) => /^-[a-z]*r[a-z]*$/.test(a)) || args.some((a) => /[*?]/.test(a)))) return "gsutil rm (recursive or wildcard)";
      return undefined;
    case "gh":
      return sub[0] === "repo" && (sub[1] === "delete" || sub[1] === "archive") ? "gh repo delete" : undefined;
    case "docker":
    case "podman":
    case "nerdctl": {
      if (sub[0] === "system" && sub[1] === "prune" && lower.some((a) => a === "--all" || a === "--volumes" || /^-[a-z]*a[a-z]*$/.test(a))) return `${word} system prune -a/--volumes`;
      if (sub[0] === "volume" && sub[1] === "prune") return `${word} volume prune`;
      if (sub[0] === "run" || sub[0] === "create") {
        if (lower.some((a) => /^--privileged(=(true|1|yes))?$/.test(a))) return `${word} run --privileged`;
        if (lower.some((a) => /^--(pid|ipc|uts|userns|network|net)=host$/.test(a) && !/^--(network|net)=host$/.test(a))) return `${word} run shares a host namespace`;
        for (let i = 0; i < lower.length; i++) {
          const capv = lower[i] === "--cap-add" ? lower[i + 1] : /^--cap-add=/.test(lower[i]) ? lower[i].slice(lower[i].indexOf("=") + 1) : undefined;
          if (capv !== undefined && /^(all|sys_admin|sys_module|sys_rawio|sys_ptrace)$/.test(capv)) return `${word} run adds dangerous capabilities`;
          const secv = lower[i] === "--security-opt" ? lower[i + 1] : /^--security-opt=/.test(lower[i]) ? lower[i].slice(lower[i].indexOf("=") + 1) : undefined;
          if (secv !== undefined && /unconfined/.test(secv)) return `${word} run disables a security profile`;
          if (lower[i] === "--pid" || lower[i] === "--ipc" || lower[i] === "--userns") if (lower[i + 1] === "host") return `${word} run shares a host namespace`;
        }
        for (let i = 0; i < args.length; i++) {
          let v: string | undefined;
          if (lower[i] === "-v" || lower[i] === "--volume" || lower[i] === "--mount") v = args[i + 1];
          else if (/^--(volume|mount)=/i.test(args[i])) v = args[i].slice(args[i].indexOf("=") + 1);
          else if (/^-v./.test(args[i])) v = args[i].slice(2);
          if (v === undefined) continue;
          const src = /(?:^|,)(?:src|source)=([^,]+)/i.exec(v)?.[1] ?? v;
          if (/^(\/|[A-Za-z]:[\\/]?)(:|$)/.test(src) || /^\/(etc|root|home|var|usr|bin|sys|proc|dev|boot|lib)?(:|$)/.test(src)) {
            return `${word} run mounts the host's root or system folders`;
          }
          if (/\/var\/run\/docker\.sock/.test(v)) return `${word} run mounts the container socket`;
          // home folder or an unresolvable variable as the source (the workspace itself is $PWD / ${PWD} / %cd% / ./ / a $(...) result)
          if (/^~/.test(src)) return `${word} run mounts the home folder`;
          if (/[$%]/.test(src) && !/^(\$PWD|\$\{PWD\}|\$SUB|%cd%)(\/|\\|:|$)/i.test(src)) return `${word} run mounts a path built from a variable`;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Strip leading control-flow words and cmd's `if ... ` prefixes so the real command is judged. */
/** Does this folder (a few levels down, skipping node_modules and .git) contain a secret file? */
function folderHoldsSecret(dir: string): boolean {
  let budget = 2000;
  const walk = (d: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (--budget < 0) return false;
      if (isSecretFile(e.name)) return true;
      if (e.isDirectory() && depth < 3 && e.name !== "node_modules" && e.name !== ".git" && walk(path.join(d, e.name), depth + 1)) return true;
    }
    return false;
  };
  try {
    if (fs.statSync(dir).isFile()) return isSecretFile(dir);
  } catch {
    return false;
  }
  return walk(dir, 0);
}

function stripControlPrefix(tokens: string[]): string[] {
  let t = tokens;
  for (let guard = 0; guard < 10 && t.length > 0; guard++) {
    const w = t[0].toLowerCase();
    if (w === "if" || w === "elif") {
      t = t.slice(1);
      // cmd: if [/i] [not] exist X | defined X | errorlevel N | a==b | a EQU b  <command>
      let i = 0;
      if (t[i]?.toLowerCase() === "/i") i++;
      if (t[i]?.toLowerCase() === "not") i++;
      const k = t[i]?.toLowerCase();
      if (k === "exist" || k === "defined" || k === "errorlevel" || k === "cmdextversion") t = t.slice(i + 2);
      else if (t[i] !== undefined && t[i].includes("==")) t = t.slice(i + 1);
      else if (t[i + 1] === "==" || ["equ", "neq", "lss", "leq", "gtr", "geq"].includes((t[i + 1] ?? "").toLowerCase())) t = t.slice(i + 3);
      // otherwise (posix) the condition is itself a command: keep it
    } else if (CONTROL_WORDS.has(w)) {
      t = t.slice(1);
    } else {
      break;
    }
  }
  return t;
}

function backstop(command: string, root: string, ctx: PolicyContext, depth: number, cwd0: string, cwdKnown0 = true): UltraVerdict {
  let cwd = cwd0;
  let cwdKnown = cwdKnown0;
  if (typeof command !== "string") return ultraAsk("command is not text");
  command = command.normalize("NFKC").replace(/[​-‏‪-‮⁠-⁤﻿]/g, "");
  if (command.length > MAX_COMMAND_CHARS) return ultraAsk(`command is longer than ${MAX_COMMAND_CHARS} characters`);
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(command)) return ultraAsk("control characters in the command");
  if (depth > MAX_SCRIPT_DEPTH + 2) return ultraAsk("commands nested too deeply");
  const shell = ctx.shell ?? DEFAULT_SHELL;
  const posix = shell !== "cmd";
  if (posix && hasAnsiCQuoting(command)) return ultraAsk("ANSI-C or locale quoting ($'...')");
  if (/:\s*\(\s*\)\s*\{/.test(command)) return ultraAsk("fork bomb");

  // Secret names anywhere in the text when the command runs inline code (node -e, python -c, PowerShell ...).
  if (INLINE_CODE.test(command)) {
    for (const m of command.matchAll(SECRET_NAME_IN_TEXT)) {
      if (isSecretFile(m[2])) return ultraAsk(`inline code mentions a secrets file (${m[2].slice(0, 40)})`);
    }
  }

  // Command substitutions run too: check their bodies, and treat the outer position as an expansion.
  if (posix) {
    const peeled = peelSubstitutions(command);
    if (!peeled) return ultraAsk("command substitutions nested too deeply");
    for (const body of peeled.inner) {
      const r = backstop(body, root, ctx, depth + 1, cwd, cwdKnown);
      if (r.verdict === "ask") return r;
    }
    command = peeled.outer;
  }

  if (unbalancedQuotes(command) || (command.match(/\{/g) ?? []).length !== (command.match(/\}/g) ?? []).length) {
    return ultraAsk("unbalanced quotes or braces");
  }
  const expanded = expandBracesText(command);
  if (expanded === undefined) return ultraAsk("large brace expansion");
  command = expanded;
  if (splitSegments(command).length > 200) return ultraAsk("too many chained commands");

  const unescape = (x: string) => (posix ? x.replace(/\\(.)/g, "$1") : x);
  const stripRef = (x: string) => x.replace(/^(@|<|file:\/\/)/i, "");
  const resolveTarget = (x: string) => path.resolve(cwd, unescape(x));
  const outside = (x: string) => {
    if (/^~/.test(x)) return true;
    const abs = /^([A-Za-z]:|[\\/])/.test(x);
    if (!cwdKnown && !abs) return true; // relative to a folder we could not work out (cd ~, cd with no argument)
    return !isInside(resolveTarget(x), root);
  };

  for (const seg of splitSegments(command)) {
    // Redirects and other writes outside the workspace, or aimed through an expansion.
    for (const m of seg.matchAll(/(?:^|\s)\d?>(?:>|\|)?\s*([^\s<>|&]+)/g)) {
      const target = m[1];
      if (target === "/dev/null" || target.toLowerCase() === "nul" || target.startsWith("&")) continue;
      if (EXPANSION_IN_TARGET.test(target)) return ultraAsk("redirect target is built from an expansion");
      if (outside(target)) return ultraAsk(`redirect writes outside the workspace (${target.slice(0, 60)})`);
    }
    for (const w of writeTargets(seg, cwd)) {
      if (!isInside(w, root) || !cwdKnown) return ultraAsk("writes outside the workspace");
    }

    let rawTokens = tokenize(seg);
    if (rawTokens.length === 0) continue;
    rawTokens = stripControlPrefix(rawTokens);
    if (rawTokens.length === 0) continue;
    if (CLOSER_WORDS.has(rawTokens[0].toLowerCase()) && rawTokens.length === 1) continue;
    if (posix && !/^([A-Za-z]:|\.\\|\\\\)/.test(rawTokens[0])) rawTokens[0] = unescape(rawTokens[0]); // r\m -> rm
    if (baseWord(rawTokens[0]) === "eval") {
      const r = backstop(rawTokens.slice(1).join(" "), root, ctx, depth + 1, cwd, cwdKnown);
      if (r.verdict === "ask") return r;
      continue;
    }
    let tokens = rawTokens;
    const unwrapped = unwrapCommand(tokens, false);
    let viaXargs = false;
    if (unwrapped && unwrapped !== "ask") {
      viaXargs = rawTokens.slice(0, rawTokens.length - unwrapped.length).some((x) => baseWord(x) === "xargs");
      tokens = unwrapped;
    }
    if (posix && baseWord(tokens[0] ?? "") === "git") tokens = tokens.map(unescape); // git pu\sh -f
    const word = baseWord(tokens[0] ?? "");
    const args = tokens.slice(1);
    const lower = args.map((a) => a.toLowerCase());
    const nonFlags = args.filter((a) => !a.startsWith("-") && !/^\/[A-Za-z?]$/.test(a));

    // Nested commands: bash -c "...", cmd /c ..., powershell -Command ...
    let inner: string | undefined;
    if (["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(word)) {
      const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
      if (ci >= 0) inner = args.slice(ci + 1).join(" ");
    } else if (word === "cmd") {
      const ci = lower.findIndex((a) => a === "/c" || a === "/k");
      if (ci >= 0) inner = args.slice(ci + 1).join(" ");
    } else if (word === "powershell" || word === "pwsh") {
      const ci = lower.findIndex((a) => a === "-c" || a === "-command");
      if (ci >= 0) inner = args.slice(ci + 1).join(" ");
      if (lower.some((a) => ["-enc", "-ec", "-encodedcommand"].includes(a)) || lower.some((a) => /^-e[a-z]*$/.test(a) && a !== "-executionpolicy")) {
        return ultraAsk("encoded PowerShell command");
      }
    }
    if (inner !== undefined) {
      const r = backstop(inner, root, ctx, depth + 1, cwd, cwdKnown);
      if (r.verdict === "ask") return r;
    }

    // Disk and OS level.
    if (ULTRA_DISK_WORDS.has(word) || /^mkfs\./.test(word)) return ultraAsk(`disk or system command "${word}"`);
    if (word === "reg" && /^(add|delete|import)$/i.test(args[0] ?? "")) return ultraAsk("registry change (reg add/delete/import)");
    if (word === "init" && /^[06]$/.test(args[0] ?? "")) return ultraAsk("init changes the run level (shutdown/reboot)");
    if (word === "systemctl" && /^(poweroff|reboot|halt|kexec|hibernate|suspend|hybrid-sleep)$/.test(lower[0] ?? "")) return ultraAsk("systemctl power command");
    if ((word === "vssadmin" || word === "wbadmin") && lower.some((a) => a === "delete")) return ultraAsk(`${word} delete`);
    if (word === "sc" && lower[0] === "delete") return ultraAsk("sc delete");
    if (word === "net" && ["user", "localgroup", "accounts"].includes(lower[0] ?? "") && lower.some((a) => a === "/add" || a === "/delete")) return ultraAsk("net user/group change");
    if (word === "crontab" && lower.includes("-r")) return ultraAsk("crontab -r");
    if (word === "zpool" && lower.includes("destroy")) return ultraAsk("zpool destroy");
    if (word === "kill" && lower.some((a, i) => (a === "-9" || a === "-kill" || a === "-sigkill") && /^(1|-1)$/.test(lower[i + 1] ?? ""))) return ultraAsk("kill pid 1 / all processes");
    if (word === "cipher" && lower.some((a) => a.startsWith("/w"))) return ultraAsk("cipher /w wipes free space");
    if (/^(set-itemproperty|new-itemproperty|remove-itemproperty|clear-itemproperty|remove-item|new-item|ri|ni|sp|rp)$/.test(word) && args.some((a) => REGISTRY_PATH.test(a.replace(/^-\w+[:=]?/, "")))) {
      return ultraAsk("registry change through PowerShell");
    }
    if (word === "git" && lower.some((a) => a === "config")) {
      const { sub, args: g } = gitParts(tokens);
      if (sub === "config" && g.some((a) => ["--list", "-l", "--get-regexp", "--show-origin"].includes(a.toLowerCase()) || /^remote\./.test(a))) {
        return ultraAsk("git config can reveal token URLs");
      }
    }
    // Destroying remote or cloud resources.
    {
      const cloud = cloudDestroyRule(word, args, lower);
      if (cloud) return ultraAsk(cloud);
    }
    // Credential dumps and environment dumps.
    const sensitiveCli =
      (word === "gh" && lower[0] === "auth" && lower[1] === "token") ||
      (word === "gcloud" && lower.some((a) => /print-(access|identity)-token/.test(a))) ||
      (word === "az" && lower.includes("get-access-token")) ||
      (word === "aws" && lower[0] === "configure" && lower[1] === "get" && /secret|token|key/.test(lower[2] ?? "")) ||
      (word === "security" && /^find-(generic|internet)-password$/.test(lower[0] ?? "")) ||
      (word === "cmdkey" && lower.some((a) => a.startsWith("/list"))) ||
      word === "vaultcmd" ||
      (word === "git" && gitParts(tokens).sub.startsWith("credential")) ||
      (word === "gh" && lower[0] === "auth" && (lower.includes("--show-token") || lower.includes("-t"))) ||
      (["get-item", "gi", "get-itemproperty", "gp", "get-itempropertyvalue", "gpv"].includes(word) && args.some((a) => /^(-path[:=])?env:/i.test(a) || /^\$?env:/i.test(a))) ||
      (word === "npm" && lower[0] === "token") ||
      word === "printenv" ||
      (word === "env" && args.length === 0) ||
      (word === "set" && args.length === 0) ||
      (word === "export" && lower[0] === "-p") ||
      (word === "declare" && lower.includes("-x")) ||
      (["get-childitem", "gci", "dir", "ls"].includes(word) && args.some((a) => /^env:/i.test(a)));
    if (sensitiveCli) return ultraAsk(`dumps credentials or the environment (${word})`);

    if (["cd", "chdir", "pushd", "set-location", "sl"].includes(word)) {
      const target = nonFlags.filter((a) => a.toLowerCase() !== "/d").pop();
      // `cd` with no argument, `cd ~`, `cd $HOME`: the folder is not the workspace and we can't say which one it is.
      if (!target && posix) cwdKnown = false;
      else if (target && (/^~/.test(target) || target === "-" || EXPANSION_IN_TARGET.test(target))) cwdKnown = false;
      else if (target) cwd = resolveTarget(target);
      continue;
    }

    // find: a start folder outside the workspace with -delete / -exec; the -exec command is judged too.
    if (word === "find") {
      const startDirs: string[] = [];
      for (const a of args) {
        if (a.startsWith("-") || a === "(" || a === "!") break;
        startDirs.push(a);
      }
      const acts = lower.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(a));
      if (acts && (startDirs.length === 0 ? !cwdKnown : startDirs.some((d) => outside(d) || EXPANSION_IN_TARGET.test(d)))) {
        return ultraAsk("find with -delete/-exec outside the workspace");
      }
      const ei = lower.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir");
      if (ei >= 0) {
        const cmdToks: string[] = [];
        for (const a of args.slice(ei + 1)) {
          if (a === ";" || a === "\\" || a === "+" || a === "\\;") break;
          cmdToks.push(a);
        }
        const r = backstop(cmdToks.filter((a) => a !== "{}").join(" "), root, ctx, depth + 1, cwd, cwdKnown);
        if (r.verdict === "ask") return r;
      }
    }

    // git: remote history, other folders, clone destinations.
    if (word === "git") {
      const { sub, args: g } = gitParts(tokens);
      for (let i = 1; i < tokens.length; i++) {
        const a = tokens[i];
        let dir: string | undefined;
        if (a === "-C" || a === "--work-tree" || a === "--git-dir") dir = tokens[i + 1];
        else if (/^--(work-tree|git-dir)=/.test(a)) dir = a.slice(a.indexOf("=") + 1);
        if (dir !== undefined && (EXPANSION_IN_TARGET.test(dir) || outside(dir))) return ultraAsk("git runs against a folder outside the workspace");
      }
      if (g.some((a, i) => a === "-C" && g[i + 1] !== undefined && outside(g[i + 1]))) return ultraAsk("git -C folder outside the workspace");
      if (sub === "clone") {
        const dest = g.filter((a) => !a.startsWith("-"))[1];
        if (dest !== undefined && (EXPANSION_IN_TARGET.test(dest) || outside(dest))) return ultraAsk("git clone destination is outside the workspace");
      }
      if (sub === "push") {
        const DANGEROUS_LONG = ["force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune"];
        const bad = g.find((a) => {
          if (/^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(a)) return true;
          if (a.startsWith("--") && a.length > 3) {
            const name = a.slice(2).split("=")[0].toLowerCase();
            if (DANGEROUS_LONG.some((o) => o.startsWith(name))) return true;
          }
          return false;
        });
        if (bad !== undefined) return ultraAsk(`git push ${bad.slice(0, 30)} rewrites or deletes remote history`);
        // refspecs: +src:dst, src:+dst, :dst (delete)
        const refspecBad = g.find((a) => !a.startsWith("-") && (a.startsWith("+") || a.startsWith(":") || /:\+/.test(a)));
        if (refspecBad !== undefined) return ultraAsk(`git push refspec ${refspecBad.slice(0, 30)} forces or deletes a remote ref`);
      }
      for (const a of g) {
        const rp = a.includes(":") && !a.startsWith("-") ? a.slice(a.indexOf(":") + 1) : "";
        if (rp && isSecretFile(unescape(rp))) return ultraAsk("git reads a secrets file");
      }
    }

    // Archives and installers that write somewhere else.
    if (word === "tar" || word === "bsdtar" || word === "unzip" || word === "expand-archive" || word === "7z" || word === "7za" || word === "7zr") {
      let dir: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = lower[i];
        if (word === "tar" || word === "bsdtar") {
          if (a === "-c" || a === "--directory") dir = args[i + 1];
          else if (/^--directory=/.test(a)) dir = args[i].slice(args[i].indexOf("=") + 1);
        } else if (word === "unzip") {
          if (a === "-d") dir = args[i + 1];
        } else if (word === "expand-archive") {
          if (a === "-destinationpath" || a === "-dest" || a === "-d") dir = args[i + 1];
        } else if (a.startsWith("-o") && a.length > 2) {
          dir = args[i].slice(2);
        }
        if (dir !== undefined && (EXPANSION_IN_TARGET.test(dir) || outside(dir))) return ultraAsk(`${word} extracts outside the workspace`);
        dir = undefined;
      }
    }
    // cp/mv -t DIR, install -t DIR
    {
      const ti = lower.findIndex((a) => a === "-t" || a === "--target-directory");
      if (ti >= 0 && args[ti + 1] !== undefined && (EXPANSION_IN_TARGET.test(args[ti + 1]) || outside(args[ti + 1]))) {
        return ultraAsk("target directory is outside the workspace");
      }
      const te = args.find((a) => /^--target-directory=/i.test(a));
      if (te !== undefined) {
        const dir = te.slice(te.indexOf("=") + 1);
        if (EXPANSION_IN_TARGET.test(dir) || outside(dir)) return ultraAsk("target directory is outside the workspace");
      }
    }

    // Delete / move / copy-over / write whose target is outside the workspace, a root, home, or built by expansion.
    const recursiveFlag = lower.some((a) => /^-[a-z]*r[a-z]*$/.test(a) || a === "--recursive" || a === "/s" || a === "-recurse" || a === "/t");
    let targets: string[] = [];
    let kind = "";
    if (ULTRA_DELETE.has(word)) {
      targets = nonFlags;
      kind = "delete";
    } else if (ULTRA_MOVE.has(word)) {
      targets = nonFlags;
      kind = "move";
    } else if (ULTRA_COPY.has(word)) {
      targets = nonFlags.slice(-1);
      kind = "copy";
    } else if (word === "robocopy") {
      targets = nonFlags.slice(0, 2);
      kind = "copy";
    } else if (ULTRA_WRITE.has(word) || (word === "sed" && lower.some((a) => /^-[a-z]*i/.test(a) || a.startsWith("--in-place")))) {
      targets = nonFlags;
      kind = "write";
    } else if (ULTRA_CHMOD.has(word) && recursiveFlag) {
      targets = nonFlags.slice(1);
      kind = "recursive permission change";
    } else if (ULTRA_ATTR.has(word)) {
      targets = args.map((a) => a.replace(/^\/[A-Za-z]:/, "")).filter((a) => a !== "" && !a.startsWith("-") && !/^\/[A-Za-z?]+$/.test(a));
      kind = "permission or attribute change";
    }
    if (viaXargs && kind !== "") return ultraAsk(`xargs feeds targets to ${word}: could not check them`);
    for (const tg of targets) {
      if (EXPANSION_IN_TARGET.test(tg)) return ultraAsk(`${kind} target is built from an expansion`);
      if (outside(tg)) return ultraAsk(`${kind} target is outside the workspace (${tg.slice(0, 60)})`);
      if (kind === "delete" && normalizePath(resolveTarget(tg)) === normalizePath(root)) return ultraAsk("delete target is the whole workspace");
    }
    if (kind === "delete" && targets.length === 0 && recursiveFlag && !cwdKnown) return ultraAsk("delete in a folder that could not be worked out");

    // Searches that sweep up secret files: rg --hidden / -u / --no-ignore*, grep -r over a folder containing one.
    if (word === "rg" && lower.some((a) => a === "--hidden" || a === "--no-ignore" || a.startsWith("--no-ignore-") || /^-u+$/.test(a) || a === "--unrestricted")) {
      return ultraAsk("rg searches hidden or ignored files");
    }
    if (
      (word === "grep" && lower.some((a) => a === "--recursive" || a === "--dereference-recursive" || /^-[a-z]*r[a-z]*$/.test(a) || a === "--directories=recurse")) ||
      (word === "findstr" && lower.includes("/s")) ||
      (["get-childitem", "gci", "select-string", "sls"].includes(word) && lower.some((a) => a === "-recurse" || a === "-r"))
    ) {
      const searchWords = ["grep", "findstr", "select-string", "sls"].includes(word);
      const given = searchWords ? nonFlags.slice(1) : nonFlags; // the first plain argument of a search is its pattern
      const dirs = given.length > 0 ? given : ["."];
      for (const d of dirs) if (!/[*?[]/.test(d) && folderHoldsSecret(resolveTarget(d))) return ultraAsk("recursive search over a folder that contains a secrets file");
    }

    // Secret files (also @file, <file, file:// forms such as curl -d @.env).
    for (const a of args) {
      const v = unescape(stripRef(a.includes("=") ? stripRef(a.slice(a.indexOf("=") + 1)) : a));
      if (!v) continue;
      if (isSecretFile(v) || /(^|[\\/])\.git[\\/]config$/i.test(v) || (/[*?[]/.test(v) && globTouchesSecret(v, cwd))) return ultraAsk("touches a secrets file");
    }
  }
  return { verdict: "allow" };
}

/**
 * Ultra mode: everything runs without a safety check except this backstop. Asks for catastrophic actions only:
 * deleting / moving / copying over / writing outside the workspace (or a root, home, or an expansion-built target),
 * force-pushing or deleting remote refs, disk / OS level commands, and reading secret files.
 */
export function ultraBackstop(command: string, root: string, ctx: PolicyContext = { written: new Set() }): UltraVerdict {
  return backstop(command, root, ctx, 0, root);
}
