// Auto-mode rules. Pure: no vscode or SDK imports, so they can be unit-tested directly.
// Allowlist-first: a command is auto-allowed only if it is a recognised safe command with no expansion tricks.
// Hard rules and anything suspicious -> "ask". Everything else -> "classify" (the model-based safety check).
// The classifier can only turn "classify" into allow/ask; it never overrides "ask".
import * as path from "node:path";

export interface PolicyContext {
  /** Absolute paths written or edited this session, normalised with normalizePath(). */
  written: ReadonlySet<string>;
  /** Body of a package.json script, if known. */
  scriptBody?: (name: string) => string | undefined;
  /** True if the file was created or changed since the team started (by any means, e.g. a shell redirect or a build). */
  freshFile?: (absPath: string) => boolean;
}

export type CommandVerdict =
  | { verdict: "allow"; rule: string }
  | { verdict: "classify"; scriptBody?: string }
  | { verdict: "ask"; rule: string };
export type EditVerdict = { verdict: "ask"; rule: string } | { verdict: "allow" };

const MAX_COMMAND_CHARS = 2000;
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
    base === "package.json" ||
    base === "makefile" ||
    base === "gnumakefile" ||
    SCRIPT_EXT.test(base)
  );
}

const SECRET_DIRS = new Set([".ssh", ".aws", ".kube", ".docker", ".gnupg", ".azure", ".config/gcloud"]);
const NON_SECRET_ENV = /^\.env\.(example|sample|template|dist)$/;

/** Does this path (or path-like token) name a file that holds credentials? Reading it always asks. */
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
  { name: "recursive delete (rm -r)", re: /\brm\b(?=[^\n]*\s(-[a-z]*r[a-z]*|--recursive)(\s|$))/i },
  { name: "recursive delete (rmdir/rd/del /s)", re: /\b(rmdir|rd|del|erase)\b[^\n]*\s\/s\b/i },
  { name: "recursive delete (Remove-Item -Recurse)", re: /\b(remove-item|ri|rm|del|rd|rmdir)\b[^\n]*\s-recurse\b/i },
  { name: "creating a link (ln/mklink)", re: /(^|[\s;&|(`])(ln|mklink)(\s|$)/i },
  { name: "creating a link (New-Item -ItemType)", re: /\b(new-item|ni)\b[^\n]*-(itemtype|type)\s+(symboliclink|hardlink|junction)\b/i },
  { name: "creating a link (fsutil hardlink)", re: /\bfsutil\b[^\n]*\bhardlink\b/i },
  { name: "xargs rm", re: /\bxargs\b[^\n]*\b(rm|del|rmdir)\b/i },
  { name: "mirror/purge delete", re: /\b(rsync\b[^\n]*--delete|robocopy\b[^\n]*\s\/(mir|purge)\b)/i },
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
  {
    name: "home directory variable",
    re: /(%userprofile%|%homepath%|%homedrive%|%appdata%|%localappdata%|\$\{?home\}?|\$env:(userprofile|home|appdata|localappdata))/i,
  },
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
    const redirectAmp = c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">" || cmd[i - 1] === "<");
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

/** Hard rules on one command string. Returns the rule that fired. */
function hardRule(cmd: string, root: string): string | undefined {
  for (const line of cmd.split(/\r?\n/)) {
    for (const r of LINE_RULES) if (r.re.test(line)) return r.name;
  }
  for (const seg of splitSegments(cmd)) {
    const word = firstWord(seg);
    if (DANGEROUS_FIRST_WORDS.has(word) || /^mkfs\./.test(word)) return `command "${word}"`;
    if (word === "reg" && /\breg(\.exe)?\s+(add|delete)\b/i.test(seg)) return "registry change (reg add/delete)";
    for (const r of SEGMENT_RULES) if (r.re.test(seg)) return r.name;
    const outside = outsideWorkspacePath(seg, root);
    if (outside) return `path outside the workspace (${outside.slice(0, 60)})`;
  }
  return undefined;
}

// ---- expansion and escapes ----

function expansionIn(cmd: string): string | undefined {
  if (/\$/.test(cmd)) return "shell expansion ($)";
  if (/`/.test(cmd)) return "shell expansion (backtick)";
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(cmd)) return "variable expansion (%VAR%)";
  if (/![A-Za-z_][A-Za-z0-9_]*!/.test(cmd)) return "variable expansion (!VAR!)";
  if (/\^/.test(cmd)) return "escape character (^)";
  if (/[A-Za-z0-9_](""|'')[A-Za-z0-9_]/.test(cmd)) return "quote-splitting in a word";
  return undefined;
}

function stripBenignRedirects(seg: string): string {
  return seg
    .replace(/&>\s*(\/dev\/null|nul)\b/gi, " ")
    .replace(/\b[12]?>>?\s*(\/dev\/null|nul)\b/gi, " ")
    .replace(/\b[12]>&[12]\b/g, " ");
}

// ---- allowlist ----

const WRITERS = new Set([
  "tee", "set-content", "add-content", "out-file", "cp", "copy", "mv", "move", "sed", "rm", "del", "erase", "ren", "rename",
  "xcopy", "robocopy", "ni", "new-item", "sc", "ac", "install", "ln", "mklink",
]);
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

type SegVerdict = { v: "allow"; rule: string } | { v: "classify"; scriptBody?: string } | { v: "ask"; rule: string };

function judgeSegment(seg: string, root: string, ctx: PolicyContext, depth: number): SegVerdict {
  const cleaned = stripBenignRedirects(seg).trim();
  const tokens = tokenize(cleaned);
  if (tokens.length === 0) return { v: "allow", rule: "empty" };
  const rawFirst = cleaned.split(/\s+/)[0] ?? "";
  if (/['"]/.test(rawFirst)) return { v: "ask", rule: "quoted command name" };
  if (rawFirst.includes("\\") && !/^([A-Za-z]:|\.\\|\\\\)/.test(rawFirst)) return { v: "ask", rule: "backslash inside the command name" };

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
    if (a.split(/[\\/]/).includes("..")) return { v: "ask", rule: "path leaves the workspace (..)" };
    if (/^~/.test(a)) return { v: "ask", rule: "home directory (~)" };
    const val = a.includes("=") ? a.slice(a.indexOf("=") + 1) : a;
    if (/^\/[A-Za-z?]$/.test(a)) continue; // cmd-style switch such as /s (a bare argument, not an option value)
    if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(val) && !SAFE_ABSOLUTE.has(val) && !isInside(val, root)) {
      return { v: "ask", rule: "path outside the workspace" };
    }
  }
  if (word === "cd" && args.some((a) => a === ".." || a.startsWith("..") )) return { v: "ask", rule: "cd leaves the workspace" };

  // Reading credentials into the conversation is not something to do silently.
  if (t.slice(1).some((a) => isSecretFile(a))) return { v: "ask", rule: "touches a secrets file" };

  if (WRITERS.has(word) && t.slice(1).some((a) => !a.startsWith("-") && isSensitivePath(path.resolve(root, a), root))) {
    return { v: "ask", rule: "writes a sensitive path" };
  }

  // A script or program created this session by any means (shell redirect, download, build) is unreviewed code.
  if (ctx.freshFile && !READ_ONLY.has(word) && word !== "git") {
    const runners = new Set(["node", "deno", "bun", "python", "python3", "py", "ruby", "perl", "php", "lua", "sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "pwsh", "powershell"]);
    const candidates = runners.has(word) ? t.slice(1).filter((a) => !a.startsWith("-")) : [];
    if (/\.(bat|cmd|ps1|sh|exe)$/i.test(t[0] ?? "") || /^\.[\\/]/.test(t[0] ?? "")) candidates.push(t[0]);
    if (candidates.some((a) => ctx.freshFile!(path.resolve(root, a)))) return { v: "ask", rule: "runs a file created this session" };
  }

  const hasRedirect = /[<>]/.test(cleaned);
  const readOnlyish = READ_ONLY.has(word) || word === "git";
  // A command that names a file written this session may be running it. Read-only utilities and git can't execute it.
  if (!readOnlyish && namesWrittenFile(t, root, ctx.written)) return { v: "ask", rule: "runs or reads a file written this session" };

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
    if (sub === "branch") {
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
  if ((word === "node" || word === "python" || word === "python3") && lowerArgs.length === 1 && ["--version", "-v"].includes(lowerArgs[0])) {
    return { v: "allow", rule: `${word} --version` };
  }
  if (word === "pytest") return { v: "allow", rule: "pytest" };
  if ((word === "python" || word === "python3") && lowerArgs[0] === "-m" && lowerArgs[1] === "pytest") return { v: "allow", rule: "pytest" };
  if (word === "cargo" && ["build", "test", "check"].includes(lowerArgs[0] ?? "")) return { v: "allow", rule: `cargo ${lowerArgs[0]}` };
  if (word === "go" && ["build", "test", "vet"].includes(lowerArgs[0] ?? "")) return { v: "allow", rule: `go ${lowerArgs[0]}` };
  if (word === "dotnet" && ["build", "test"].includes(lowerArgs[0] ?? "")) return { v: "allow", rule: `dotnet ${lowerArgs[0]}` };
  // Bare binaries as they appear in package.json scripts (node_modules/.bin is on the PATH there).
  if (word === "tsc" || word === "vitest" || word === "eslint") return { v: "allow", rule: word };
  if (word === "prettier" && lowerArgs.includes("--check")) return { v: "allow", rule: "prettier --check" };
  if (word === "npx") {
    const tool = lowerArgs[0] ?? "";
    if (tool === "tsc" || tool === "vitest" || tool === "eslint") return { v: "allow", rule: `npx ${tool}` };
    if (tool === "prettier" && lowerArgs.includes("--check")) return { v: "allow", rule: "npx prettier --check" };
    return { v: "classify" };
  }
  if (word === "npm" || word === "pnpm" || word === "yarn") return judgeScript(word, lowerArgs, args, root, ctx, depth);
  return { v: "classify" };
}

/** npm|pnpm|yarn test / run <script>: check the script body itself, recursively. */
function judgeScript(pm: string, lowerArgs: string[], args: string[], root: string, ctx: PolicyContext, depth: number): SegVerdict {
  let name: string | undefined;
  if (lowerArgs[0] === "test" || lowerArgs[0] === "t") name = "test";
  else if (lowerArgs[0] === "run" || lowerArgs[0] === "run-script") name = args[1];
  else return { v: "classify" };
  if (!name || name.startsWith("-")) return { v: "classify" };
  if (ctx.written.has(normalizePath(path.resolve(root, "package.json")))) {
    return { v: "ask", rule: "package.json was changed this session" };
  }
  const body = ctx.scriptBody?.(name);
  if (body === undefined || depth >= MAX_SCRIPT_DEPTH) return { v: "classify" };
  const inner = judge(body, root, ctx, depth + 1);
  if (inner.verdict === "ask") return { v: "ask", rule: `script "${name}": ${inner.rule}` };
  const listed = name === "test" || name === "lint" || name === "build";
  if (inner.verdict === "allow" && listed) return { v: "allow", rule: `${pm} ${name} (script is safe)` };
  return { v: "classify", scriptBody: body };
}

function judge(command: string, root: string, ctx: PolicyContext, depth: number): CommandVerdict {
  if (typeof command !== "string") return { verdict: "ask", rule: "command is not text" };
  // Fold lookalike characters and drop invisible ones so they can't hide a keyword.
  command = command.normalize("NFKC").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "");
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(command)) return { verdict: "ask", rule: "control characters in the command" };
  if (splitSegments(command).length > 40) return { verdict: "ask", rule: "too many chained commands" };
  if (command.length > MAX_COMMAND_CHARS) return { verdict: "ask", rule: `command is longer than ${MAX_COMMAND_CHARS} characters` };
  if (!command.trim()) return { verdict: "ask", rule: "empty command" };
  const exp = expansionIn(command);
  if (exp) return { verdict: "ask", rule: exp };
  if (unbalancedQuotes(command)) return { verdict: "ask", rule: "unbalanced quotes" };
  const hard = hardRule(command, root);
  if (hard) return { verdict: "ask", rule: hard };

  let allowRule = "";
  let classify = false;
  let scriptBody: string | undefined;
  for (const seg of splitSegments(command)) {
    const r = judgeSegment(seg, root, ctx, depth);
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
  return judge(command, root, ctx, 0);
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
