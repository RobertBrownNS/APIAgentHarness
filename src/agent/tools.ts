import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { z } from "zod";
import { scrubEnv } from "./envFilter";
import { isSecretEither } from "./secretPaths";
import { confinePath, displayPath } from "./paths";
import { findMatches, looksBinary, numberLines, replaceUnique, truncateMiddle } from "./textOps";

export interface ToolContext {
  root: string;
  signal: AbortSignal;
  commandTimeoutSec: number;
  output: vscode.OutputChannel;
}

export class ToolError extends Error {}

const EXCLUDE = "**/{node_modules,.git,dist,out,build,.next,.venv,__pycache__}/**";
const MAX_READ_BYTES = 2 * 1024 * 1024;

const schemas = {
  read_file: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  }),
  list_files: z.object({ glob: z.string().min(1).optional() }),
  search_text: z.object({
    pattern: z.string().min(1),
    glob: z.string().min(1).optional(),
    case_sensitive: z.boolean().optional(),
  }),
  edit_file: z.object({ path: z.string().min(1), old_str: z.string().min(1), new_str: z.string() }),
  write_file: z.object({ path: z.string().min(1), contents: z.string() }),
  run_command: z.object({ command: z.string().min(1) }),
};

export type ToolName = keyof typeof schemas;

/** Tools that change files or run code need approval. */
export const MUTATING: ReadonlySet<string> = new Set<ToolName>(["edit_file", "write_file", "run_command"]);

export const toolDefinitions: Anthropic.Beta.BetaTool[] = [
  {
    name: "read_file",
    description:
      "Read a text file from the workspace. Returns numbered lines. Use offset and limit for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        offset: { type: "integer", description: "1-based line to start from" },
        limit: { type: "integer", description: "Maximum lines to return (default 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    description:
      "List workspace files matching a glob (default **/*). node_modules, .git and build folders are skipped. Returns at most 500 paths.",
    input_schema: {
      type: "object",
      properties: { glob: { type: "string", description: "Glob such as src/**/*.ts" } },
      additionalProperties: false,
    },
  },
  {
    name: "search_text",
    description:
      "Search file contents with a JavaScript regular expression. Returns path:line: text for up to 200 matches.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        glob: { type: "string", description: "Limit the search to files matching this glob" },
        case_sensitive: { type: "boolean", description: "Default false" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact occurrence of old_str with new_str in a file. old_str must match exactly once, including whitespace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string", description: "Exact text to replace" },
        new_str: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_str", "new_str"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create a file, or overwrite an existing one, with the given contents. Creates folders as needed.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, contents: { type: "string" } },
      required: ["path", "contents"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace root and return its exit code and combined output (long output is trimmed in the middle). Do not start servers or other commands that never exit.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }) as Anthropic.Beta.BetaTool);

/** Validate model input against the tool's schema. Throws ToolError with a readable message. */
export function parseToolInput(name: string, input: unknown): unknown {
  const schema = Object.hasOwn(schemas, name) ? schemas[name as ToolName] : undefined;
  if (!schema) throw new ToolError(`unknown tool: ${name}`);
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ToolError(
      `invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<string> {
  switch (name as ToolName) {
    case "read_file":
      return readFile(input as z.infer<typeof schemas.read_file>, ctx);
    case "list_files":
      return listFiles(input as z.infer<typeof schemas.list_files>, ctx);
    case "search_text":
      return searchText(input as z.infer<typeof schemas.search_text>, ctx);
    case "edit_file":
      return editFile(input as z.infer<typeof schemas.edit_file>, ctx);
    case "write_file":
      return writeFile(input as z.infer<typeof schemas.write_file>, ctx);
    case "run_command":
      return runCommand(input as z.infer<typeof schemas.run_command>, ctx);
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}

function hiddenNote(n: number): string {
  return n > 0 ? `\n(${n} secret file${n === 1 ? "" : "s"} hidden; use read_file to request access)` : "";
}

/** Globs must stay inside the workspace: no absolute paths and no ".." segments. */
function checkGlob(glob: string | undefined): string {
  const g = glob ?? "**/*";
  if (/^([a-zA-Z]:|[\/])/.test(g) || g.split(/[\/]/).includes("..")) {
    throw new ToolError("glob must be relative to the workspace and must not contain '..'");
  }
  return g;
}

function resolve(ctx: ToolContext, p: string): vscode.Uri {
  try {
    return vscode.Uri.file(confinePath(ctx.root, p));
  } catch (e) {
    throw new ToolError((e as Error).message);
  }
}

/** Read through the open document if there is one, so unsaved edits are included. */
async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    throw new ToolError(`file not found: ${uri.fsPath}`);
  }
  if (stat.type & vscode.FileType.Directory) throw new ToolError("path is a directory; use list_files");
  if (stat.size > MAX_READ_BYTES) throw new ToolError(`file is too large (${stat.size} bytes)`);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (looksBinary(bytes)) throw new ToolError("file looks binary");
  return new TextDecoder().decode(bytes);
}

async function readFile(input: z.infer<typeof schemas.read_file>, ctx: ToolContext): Promise<string> {
  const text = await readText(resolve(ctx, input.path));
  return text.length === 0 ? "(empty file)" : truncateMiddle(numberLines(text, input.offset, input.limit), 100_000);
}

async function listFiles(input: z.infer<typeof schemas.list_files>, ctx: ToolContext): Promise<string> {
  const pattern = new vscode.RelativePattern(ctx.root, checkGlob(input.glob));
  const uris = await vscode.workspace.findFiles(pattern, EXCLUDE, 500);
  let hidden = 0;
  const paths = uris
    .filter((u) => {
      try {
        confinePath(ctx.root, u.fsPath);
      } catch {
        return false;
      }
      if (isSecretEither(u.fsPath, ctx.root)) {
        hidden++;
        return false;
      }
      return true;
    })
    .map((u) => displayPath(ctx.root, u.fsPath))
    .sort();
  const note = hiddenNote(hidden);
  if (paths.length === 0) return `No files matched.${note}`;
  return paths.join("\n") + (paths.length === 500 ? "\n... (stopped at 500 results; narrow the glob)" : "") + note;
}

async function searchText(input: z.infer<typeof schemas.search_text>, ctx: ToolContext): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, input.case_sensitive ? "" : "i");
  } catch (e) {
    throw new ToolError(`invalid regular expression: ${(e as Error).message}`);
  }
  const pattern = new vscode.RelativePattern(ctx.root, checkGlob(input.glob));
  const uris = await vscode.workspace.findFiles(pattern, EXCLUDE, 5000);
  const results: string[] = [];
  const MAX = 200;
  const MAX_LINE = 2000; // long lines are where backtracking regexes blow up
  const deadline = Date.now() + 10_000;
  let timedOut = false;
  let hidden = 0;
  for (const uri of uris) {
    if (ctx.signal.aborted || results.length >= MAX) break;
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    if (isSecretEither(uri.fsPath, ctx.root)) {
      hidden++;
      continue;
    }
    let bytes: Uint8Array;
    try {
      confinePath(ctx.root, uri.fsPath); // skip symlinks that lead outside the workspace
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 1024 * 1024) continue;
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue;
    }
    if (looksBinary(bytes)) continue;
    const rel = displayPath(ctx.root, uri.fsPath);
    const text = new TextDecoder()
      .decode(bytes)
      .split("\n")
      .map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l))
      .join("\n");
    for (const m of findMatches(text, re, MAX - results.length)) {
      results.push(`${rel}:${m.line}: ${m.text}`);
    }
  }
  const note = hiddenNote(hidden);
  if (results.length === 0) return `No matches.${note}`;
  return results.join("\n") + (results.length >= MAX ? `\n... (stopped at ${MAX} matches)` : "") + note;
}

/** Apply an edit through VS Code so it shows in open editors and can be undone. */
/** Returns a note for the model when the file held unsaved user changes (then it is left unsaved). */
async function replaceDocument(uri: vscode.Uri, text: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const wasDirty = doc.isDirty;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  if (!(await vscode.workspace.applyEdit(edit))) throw new ToolError("VS Code refused the edit");
  if (wasDirty) return " The file has unsaved changes made by the user, so the edit was applied but not saved.";
  await doc.save();
  return "";
}

async function editFile(input: z.infer<typeof schemas.edit_file>, ctx: ToolContext): Promise<string> {
  const uri = resolve(ctx, input.path);
  const result = replaceUnique(await readText(uri), input.old_str, input.new_str);
  if (!result.ok) throw new ToolError(result.error);
  const note = await replaceDocument(uri, result.text);
  return `Edited ${displayPath(ctx.root, uri.fsPath)}.${note}`;
}

async function writeFile(input: z.infer<typeof schemas.write_file>, ctx: ToolContext): Promise<string> {
  const uri = resolve(ctx, input.path);
  const rel = displayPath(ctx.root, uri.fsPath);
  let exists = true;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    exists = false;
  }
  if (exists) {
    const note = await replaceDocument(uri, input.contents);
    return `Overwrote ${rel}.${note}`;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(uri, { contents: new TextEncoder().encode(input.contents) });
  if (!(await vscode.workspace.applyEdit(edit))) throw new ToolError("VS Code refused to create the file");
  return `Created ${rel}`;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

function runCommand(input: z.infer<typeof schemas.run_command>, ctx: ToolContext): Promise<string> {
  if (ctx.signal.aborted) return Promise.resolve("killed: stopped by user");
  const timeoutSec = Number.isFinite(ctx.commandTimeoutSec) && ctx.commandTimeoutSec > 0 ? ctx.commandTimeoutSec : 120;
  return new Promise((resolvePromise) => {
    ctx.output.appendLine(`
$ ${input.command}`);
    const child = spawn(input.command, {
      cwd: ctx.root,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32", // own process group so we can kill the tree
      stdio: ["ignore", "pipe", "pipe"], // stdin at EOF so commands that read it don't hang
      env: scrubEnv(process.env), // no ANTHROPIC_*, AWS_*, *_TOKEN, *_SECRET, *_KEY ... (all modes)
    });
    // Keep the start and a rolling window of the end; errors are usually at the end.
    const HEAD = 1_000_000;
    const TAIL = 1_000_000;
    let head = "";
    let tail = "";
    let dropped = 0;
    let ended = false;
    let reason = "";
    const onData = (s: string) => {
      ctx.output.append(s);
      if (head.length < HEAD) {
        const room = HEAD - head.length;
        head += s.slice(0, room);
        s = s.slice(room);
      }
      if (!s) return;
      tail += s;
      if (tail.length > TAIL) {
        dropped += tail.length - TAIL;
        tail = tail.slice(tail.length - TAIL);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const finish = (summary: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      ctx.output.appendLine(`[${summary}]`);
      const out = head + (dropped ? `
... (${dropped} characters omitted) ...
` : "") + tail;
      resolvePromise(`${summary}
${truncateMiddle(out) || "(no output)"}`);
    };
    const stop = (why: string) => {
      if (ended) return;
      reason = why;
      killTree(child.pid);
      // If a surviving grandchild keeps the pipes open, 'close' never fires; don't wait forever.
      setTimeout(() => finish(`killed: ${reason}`), 2000).unref();
    };
    const timer = setTimeout(() => stop(`timed out after ${timeoutSec}s`), timeoutSec * 1000);
    const onAbort = () => stop("stopped by user");
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => finish(`failed to start: ${e.message}`));
    child.on("close", (code, signal) =>
      finish(reason ? `killed: ${reason}` : `exit code ${code ?? signal ?? "unknown"}`),
    );
  });
}
