// Pure text helpers used by the tools. No vscode imports, so they are unit-testable.

export type ReplaceResult = { ok: true; text: string } | { ok: false; error: string };

/** Replace exactly one occurrence of oldStr. Tolerates CRLF files when oldStr uses LF. */
export function replaceUnique(content: string, oldStr: string, newStr: string): ReplaceResult {
  if (oldStr.length === 0) return { ok: false, error: "old_str must not be empty" };

  let find = oldStr;
  let replace = newStr;
  if (content.includes("\r\n") && !oldStr.includes("\r\n")) {
    find = oldStr.replace(/\n/g, "\r\n");
    replace = newStr.replace(/\r?\n/g, "\r\n");
  }

  const first = content.indexOf(find);
  if (first === -1) {
    return { ok: false, error: "old_str was not found in the file. Read the file again and copy the text exactly." };
  }
  if (content.indexOf(find, first + 1) !== -1) {
    return { ok: false, error: "old_str matches more than once. Include more surrounding lines so it is unique." };
  }
  return { ok: true, text: content.slice(0, first) + replace + content.slice(first + find.length) };
}

/** Number lines like `cat -n`, starting at `offset` (1-based), at most `limit` lines. */
export function numberLines(content: string, offset = 1, limit = 2000): string {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, offset);
  const slice = lines.slice(start - 1, start - 1 + limit);
  const width = String(start + slice.length - 1).length;
  const body = slice.map((l, i) => `${String(start + i).padStart(width)}\t${l}`).join("\n");
  const remaining = lines.length - (start - 1 + slice.length);
  return remaining > 0 ? `${body}\n... (${remaining} more lines; use offset to read further)` : body;
}

/** Keep the head and tail of long output so the model sees both the start and the end. */
export function truncateMiddle(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - max;
  return `${text.slice(0, half)}\n\n... [${dropped} characters omitted] ...\n\n${text.slice(-half)}`;
}

export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Find regex matches line by line. Returns "line: text" strings, each capped at 200 chars. */
export function findMatches(content: string, re: RegExp, max: number): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < max; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) out.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
  }
  return out;
}
