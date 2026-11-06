// Pure history helpers (no vscode import) so message placement can be unit-tested.
import type Anthropic from "@anthropic-ai/sdk";

type Msg = Anthropic.Beta.BetaMessageParam;
type Blocks = Anthropic.Beta.BetaContentBlockParam[];

/**
 * Add a user turn to the history, then the drained system notes right after it. Mutates and returns msgs.
 * - If the last non-system message is a user message (after Stop or an API error), `content` is merged into it
 *   (existing blocks first, so tool_results stay ahead of text) and trailing system notes stay where they are.
 *   The new notes still go at the end, so they follow the merged user content.
 * - Otherwise a new user message is pushed.
 * - Blank notes are ignored. Each note becomes `{role: "system", content}`.
 */
export function appendUserTurn(msgs: Msg[], content: string | Blocks, notes: readonly string[] = [], asText = false): Msg[] {
  const noteBlocks: Blocks = asText
    ? notes.filter((n) => n.trim()).map((n) => ({ type: "text", text: `<system-note>${n}</system-note>` }))
    : [];
  if (asText && noteBlocks.length) {
    content = [...(typeof content === "string" ? [{ type: "text" as const, text: content }] : content), ...noteBlocks];
  }
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].role === "system") i--;
  const last = i >= 0 ? msgs[i] : undefined;
  if (last && last.role === "user") {
    const prev: Blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
    const add: Blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    last.content = [...prev, ...add];
  } else {
    msgs.push({ role: "user", content });
  }
  if (asText) return msgs;
  for (const note of notes) {
    if (note.trim()) msgs.push({ role: "system", content: note });
  }
  return msgs;
}

/**
 * Fallback for APIs that reject mid-conversation system messages. Only the unanswered tail (messages after the last
 * assistant message) is rewritten: each system message there is removed and its text folded into the closest earlier
 * user message as a <system-note> block. Earlier, already-answered messages are never touched (editing answered history
 * can invalidate preserved thinking). Mutates msgs; returns how many system messages were converted.
 */
export function systemNotesToText(msgs: Msg[]): number {
  let start = msgs.length - 1;
  while (start >= 0 && msgs[start].role !== "assistant") start--;
  start++; // first message of the unanswered tail
  let n = 0;
  for (let i = msgs.length - 1; i >= start; i--) {
    const m = msgs[i];
    if (m.role !== "system") continue;
    let target: Anthropic.Beta.BetaUserMessageParam | undefined;
    for (let j = i - 1; j >= start; j--) {
      const cand = msgs[j];
      if (cand.role === "user") {
        target = cand;
        break;
      }
    }
    if (!target) continue; // nothing in the tail to fold into: leave it
    const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => ("text" in b ? b.text : "")).join("\n");
    msgs.splice(i, 1);
    n++;
    const prev: Blocks = typeof target.content === "string" ? [{ type: "text", text: target.content }] : [...target.content];
    prev.push({ type: "text", text: `<system-note>${text}</system-note>` });
    target.content = prev;
  }
  return n;
}
