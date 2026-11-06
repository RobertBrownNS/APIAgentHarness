import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { appendUserTurn, systemNotesToText } from "../src/agent/history";

type Msg = Anthropic.Beta.BetaMessageParam;
const sys = (content: string) => ({ role: "system", content }) as unknown as Msg;
const user = (content: Msg["content"]) => ({ role: "user", content }) as Msg;
const asst = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as Msg;
const roles = (m: Msg[]) => m.map((x) => x.role as string);

/** The API rule: a system message must be last or be followed by an assistant message, never by a user message. */
function assertValid(msgs: Msg[]) {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "system") continue;
    const next = msgs[i + 1];
    if (next) expect(["assistant", "system"], `msg ${i} followed by ${next.role}`).toContain(next.role);
    if (i === 0) throw new Error("system message must not be first");
  }
  // user messages must not be adjacent
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role === "user") expect(msgs[i - 1].role, `user at ${i}`).not.toBe("user");
  }
}

describe("appendUserTurn: new turn", () => {
  it("pushes a user message onto an empty history", () => {
    const m: Msg[] = [];
    appendUserTurn(m, "hi");
    expect(m).toEqual([{ role: "user", content: "hi" }]);
  });
  it("pushes after an assistant message", () => {
    const m = [user("a"), asst("b")];
    appendUserTurn(m, "c");
    expect(roles(m)).toEqual(["user", "assistant", "user"]);
  });
  it("returns the same (mutated) array", () => {
    const m: Msg[] = [];
    expect(appendUserTurn(m, "x")).toBe(m);
  });
  it("puts notes right after the new user message, in order", () => {
    const m = [user("a"), asst("b")];
    appendUserTurn(m, "c", ["n1", "n2"]);
    expect(roles(m)).toEqual(["user", "assistant", "user", "system", "system"]);
    expect((m[3] as { content: string }).content).toBe("n1");
    expect((m[4] as { content: string }).content).toBe("n2");
    assertValid(m);
  });
  it("no notes, no system messages", () => {
    const m = [user("a"), asst("b")];
    appendUserTurn(m, "c");
    appendUserTurn(m, "d", []);
    expect(roles(m)).not.toContain("system");
  });
  it("blank, whitespace-only and empty notes are ignored", () => {
    const m: Msg[] = [];
    appendUserTurn(m, "hi", ["", "  ", "\n\t", "real"]);
    expect(roles(m)).toEqual(["user", "system"]);
  });
  it("tool_results turn: a block array after an assistant tool_use becomes a new user message, notes after it", () => {
    const m: Msg[] = [
      user("go"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] } as Msg,
    ];
    const results = [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] as never;
    appendUserTurn(m, results, ["Mode is now Plan."]);
    expect(roles(m)).toEqual(["user", "assistant", "user", "system"]);
    expect((m[2].content as { type: string }[])[0].type).toBe("tool_result");
    assertValid(m);
  });
  it("keeps string content as a string for a fresh message (no needless conversion)", () => {
    const m: Msg[] = [];
    appendUserTurn(m, "plain");
    expect(typeof m[0].content).toBe("string");
  });
});

describe("appendUserTurn: merging into a trailing user message (after Stop or an API error)", () => {
  it("merges text into a trailing user message instead of making two user messages", () => {
    const m = [user("first")];
    appendUserTurn(m, "second");
    expect(m).toHaveLength(1);
    expect(m[0].content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });
  it("existing blocks come first, so tool_results stay ahead of text", () => {
    const tr = { type: "tool_result", tool_use_id: "t1", content: "ok" };
    const m = [asst("x"), user([tr] as never)];
    appendUserTurn(m, "more");
    expect(m).toHaveLength(2);
    const c = m[1].content as { type: string }[];
    expect(c[0].type).toBe("tool_result");
    expect(c[1]).toEqual({ type: "text", text: "more" });
  });
  it("array content is merged after the existing blocks", () => {
    const m = [user([{ type: "text", text: "a" }])];
    appendUserTurn(m, [{ type: "text", text: "b" }, { type: "text", text: "c" }]);
    expect((m[0].content as { text: string }[]).map((b) => b.text)).toEqual(["a", "b", "c"]);
  });
  it("merges across trailing system notes; old notes stay where they were, new notes go last", () => {
    const m = [asst("x"), user("u"), sys("old1"), sys("old2")];
    appendUserTurn(m, "new", ["fresh"]);
    expect(roles(m)).toEqual(["assistant", "user", "system", "system", "system"]);
    expect((m[1].content as { text: string }[]).map((b) => b.text)).toEqual(["u", "new"]);
    expect(m.slice(2).map((x) => x.content)).toEqual(["old1", "old2", "fresh"]);
    assertValid(m);
  });
  it("never puts a user message after a system message", () => {
    const m = [asst("x"), user("u"), sys("old")];
    appendUserTurn(m, "new");
    appendUserTurn(m, "newer", ["n"]);
    expect(roles(m)).toEqual(["assistant", "user", "system", "system"]);
    assertValid(m);
  });
  it("a system note followed by an assistant message is a valid place for the next user turn", () => {
    const m = [user("u"), sys("note"), asst("a")];
    appendUserTurn(m, "next");
    expect(roles(m)).toEqual(["user", "system", "assistant", "user"]);
    assertValid(m);
  });
  it("only system messages in history: a user message is still added", () => {
    const m = [sys("n")];
    appendUserTurn(m, "u");
    expect(roles(m)).toContain("user");
  });
  it("repeated stop/send cycles never produce adjacent user messages or a user after a system", () => {
    const m: Msg[] = [];
    for (let i = 0; i < 6; i++) {
      appendUserTurn(m, `t${i}`, i % 2 ? [`note${i}`] : []);
      if (i % 3 === 2) m.push(asst(`a${i}`));
    }
    assertValid(m);
  });
  it("a long mixed history stays valid after each of many appends", () => {
    const m: Msg[] = [];
    for (let i = 0; i < 50; i++) {
      appendUserTurn(m, `u${i}`, i % 4 === 0 ? [`n${i}`, `m${i}`] : []);
      if (i % 5 !== 0) m.push(asst(`a${i}`));
      assertValid(m);
    }
  });
  it("does not mutate the caller's content array or notes array", () => {
    const content = [{ type: "text", text: "b" }] as never;
    const notes = Object.freeze(["n"]);
    const m = [user("a")];
    appendUserTurn(m, content, notes);
    expect(content).toEqual([{ type: "text", text: "b" }]);
    expect(notes).toEqual(["n"]);
  });
});

describe("appendUserTurn asText fallback", () => {
  it("folds notes into the user message as <system-note> text blocks and adds no system messages", () => {
    const m = [user("a"), asst("b")];
    appendUserTurn(m, "c", ["n1", "n2"], true);
    expect(roles(m)).toEqual(["user", "assistant", "user"]);
    const texts = (m[2].content as { text: string }[]).map((b) => b.text);
    expect(texts).toEqual(["c", "<system-note>n1</system-note>", "<system-note>n2</system-note>"]);
  });
  it("blank notes are skipped; no notes leaves content unchanged", () => {
    const m: Msg[] = [];
    appendUserTurn(m, "hi", ["", " "], true);
    expect(m[0].content).toBe("hi");
  });
  it("merges into a trailing user message too, without creating adjacent user messages", () => {
    const m = [asst("a"), user("u")];
    appendUserTurn(m, "v", ["n"], true);
    expect(roles(m)).toEqual(["assistant", "user"]);
    expect((m[1].content as { text: string }[]).map((b) => b.text)).toEqual(["u", "v", "<system-note>n</system-note>"]);
  });
  it("tool_results content keeps its blocks first and gets the note after", () => {
    const tr = [{ type: "tool_result", tool_use_id: "t", content: "ok" }] as never;
    const m = [asst("a")];
    appendUserTurn(m, tr, ["n"], true);
    const c = m[1].content as { type: string }[];
    expect(c[0].type).toBe("tool_result");
    expect(c[1].type).toBe("text");
  });
});

describe("systemNotesToText (only the unanswered tail is rewritten)", () => {
  const texts = (m: Msg) => (m.content as { text: string }[]).map((b) => b.text);
  it("folds system messages after the last assistant message into the closest earlier user message", () => {
    const m = [user("u"), asst("a"), user("v"), sys("n1")];
    expect(systemNotesToText(m)).toBe(1);
    expect(roles(m)).toEqual(["user", "assistant", "user"]);
    expect(texts(m[2])).toEqual(["v", "<system-note>n1</system-note>"]);
  });
  it("leaves already-answered history untouched, including its system messages", () => {
    const m = [user("u"), sys("old"), asst("a"), user("v"), sys("new")];
    expect(systemNotesToText(m)).toBe(1);
    expect(roles(m)).toEqual(["user", "system", "assistant", "user"]);
    expect(m[0].content).toBe("u");
    expect(texts(m[3])).toEqual(["v", "<system-note>new</system-note>"]);
  });
  it("is a no-op when the tail has no system messages", () => {
    const m = [user("u"), sys("old"), asst("a"), user("v")];
    expect(systemNotesToText(m)).toBe(0);
    expect(roles(m)).toEqual(["user", "system", "assistant", "user"]);
  });
  it("two notes on the same user message are both folded, in order", () => {
    const m = [asst("a"), user("u"), sys("a"), sys("b")];
    expect(systemNotesToText(m)).toBe(2);
    expect(texts(m[1])).toEqual(["u", "<system-note>b</system-note>", "<system-note>a</system-note>"]);
    expect(roles(m)).toEqual(["assistant", "user"]);
  });
  it("with no assistant message at all the whole history is the tail", () => {
    const m = [user("u"), sys("n")];
    expect(systemNotesToText(m)).toBe(1);
    expect(roles(m)).toEqual(["user"]);
  });
  it("a system message with no user message in the tail is left where it is (nothing to fold into)", () => {
    const m = [user("u"), asst("a"), sys("n")];
    expect(systemNotesToText(m)).toBe(0);
    expect(roles(m)).toEqual(["user", "assistant", "system"]);
  });
  it("handles array-form system content", () => {
    const m = [asst("a"), user("u"), { role: "system", content: [{ type: "text", text: "arr" }] } as unknown as Msg];
    systemNotesToText(m);
    expect(JSON.stringify(m[1].content)).toContain("arr");
  });
  it("does not touch tool_result blocks already in the user message", () => {
    const tr = { type: "tool_result", tool_use_id: "t", content: "ok" };
    const m = [asst("a"), user([tr] as never), sys("n")];
    systemNotesToText(m);
    const c = m[1].content as { type: string }[];
    expect(c[0]).toEqual(tr);
    expect(c[1].type).toBe("text");
  });
  it("the result has no system messages left in the tail and stays valid", () => {
    const m = [user("u"), asst("a"), user("v"), sys("n2"), sys("n3")];
    systemNotesToText(m);
    assertValid(m);
    expect(m.some((x) => x.role === "system")).toBe(false);
  });
});
