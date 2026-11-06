import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";
import type { ChatItem, Effort, HostMessage } from "../shared/protocol";
import { ApprovalBroker, type ApprovalResult } from "./approvals";
import { createClient } from "./client";
import { buildSystemPrompt } from "./systemPrompt";
import { MUTATING, parseToolInput, runTool, ToolError, toolDefinitions } from "./tools";

type Msg = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

interface Settings {
  model: string;
  effort: Effort;
  maxTokens: number;
  autoApproveReads: boolean;
  commandTimeoutSec: number;
  refusalFallback: boolean;
}

interface Run {
  gen: number;
  signal: AbortSignal;
  msgs: Msg[];
}

const MAX_UI_OUTPUT = 20_000;
const MAX_RETRIES = 2;
const INPUT_UPDATE_MS = 100;

function clip(s: string): string {
  return s.length > MAX_UI_OUTPUT
    ? `${s.slice(0, MAX_UI_OUTPUT)}\n... (${s.length - MAX_UI_OUTPUT} more characters not shown)`
    : s;
}

/** One chat: message history sent to the API plus the transcript shown in the panel. */
export class AgentSession {
  readonly approvals = new ApprovalBroker();
  private messages: Msg[] = [];
  private items: ChatItem[] = [];
  private abort?: AbortController;
  private _busy = false;
  private nextId = 1;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly emit: (m: HostMessage) => void,
  ) {}

  get busy(): boolean {
    return this._busy;
  }

  get transcript(): ChatItem[] {
    return this.items;
  }

  // ---- transcript helpers ----

  private gen = 0;

  private uid(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private upsert(item: ChatItem, gen = this.gen): void {
    if (gen !== this.gen) return; // stale run after reset()
    const i = this.items.findIndex((x) => x.id === item.id);
    if (i >= 0) this.items[i] = item;
    else this.items.push(item);
    this.emit({ type: "item", item });
  }

  private append(id: string, text: string, gen = this.gen): void {
    if (gen !== this.gen) return;
    const it = this.items.find((x) => x.id === id);
    if (!it || (it.kind !== "text" && it.kind !== "thinking")) return;
    it.text += text;
    this.emit({ type: "append", id, text });
  }

  private notice(level: "info" | "error", text: string, gen = this.gen): void {
    this.upsert({ kind: "notice", id: this.uid("notice"), level, text }, gen);
  }

  private updateTool(id: string, patch: Partial<ToolItem>, gen = this.gen): void {
    if (gen !== this.gen) return;
    const it = this.items.find((x) => x.id === id);
    if (it?.kind === "tool") this.upsert({ ...it, ...patch }, gen);
  }

  // ---- public API ----

  stop(): void {
    if (!this._busy || !this.abort || this.abort.signal.aborted) return;
    this.abort.abort();
    this.approvals.cancelAll("stopped by user");
    this.notice("info", "Stopped.");
  }

  reset(): void {
    this.gen++; // any run still unwinding becomes a no-op
    this.abort?.abort();
    this.approvals.reset();
    this.messages = [];
    this.items = [];
    this._busy = false;
    this.emit({ type: "busy", busy: false });
  }

  async send(text: string): Promise<void> {
    if (this._busy || typeof text !== "string" || !text.trim()) return;
    this._busy = true; // claim synchronously so a double send can't start two loops
    const gen = this.gen;
    const abort = new AbortController();
    this.abort = abort;
    this.emit({ type: "busy", busy: true });
    const msgs = this.messages;
    try {
      this.upsert({ kind: "user", id: this.uid("user"), text }, gen);

      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        this.notice("error", "Open a folder or workspace first; the agent works inside it.", gen);
        return;
      }
      const client = await createClient(this.context.secrets);
      if (!client) {
        this.notice("error", "No API key found. Run 'Agent Harness: Set API Key'.", gen);
        return;
      }
      if (gen !== this.gen) return;

      // Merge into a trailing user message (after Stop or an API error) to keep roles alternating.
      const last = msgs[msgs.length - 1];
      if (last && last.role === "user") {
        const blocks: Anthropic.Beta.BetaContentBlockParam[] =
          typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
        blocks.push({ type: "text", text });
        last.content = blocks;
      } else {
        msgs.push({ role: "user", content: text });
      }

      const cfg = vscode.workspace.getConfiguration("agentHarness");
      const settings: Settings = {
        model: cfg.get<string>("model", "claude-opus-5-5"),
        effort: cfg.get<Effort>("effort", "high"),
        maxTokens: cfg.get<number>("maxTokens", 64000),
        autoApproveReads: cfg.get<boolean>("autoApproveReads", true),
        commandTimeoutSec: cfg.get<number>("commandTimeoutSec", 120),
        refusalFallback: cfg.get<boolean>("refusalFallback", true),
      };
      await this.runLoop({ gen, signal: abort.signal, msgs }, client, root, settings);
    } catch (err) {
      this.reportError(err, gen, abort.signal);
    } finally {
      if (gen === this.gen) {
        // Anything still in flight (after Stop or an error) is no longer running.
        for (const it of [...this.items]) {
          if (it.kind === "tool" && (it.status === "streaming" || it.status === "awaiting" || it.status === "running")) {
            this.upsert({ ...it, status: "error" }, gen);
          }
        }
        this._busy = false;
        this.emit({ type: "busy", busy: false });
      }
    }
  }

  private reportError(err: unknown, gen: number, signal: AbortSignal): void {
    if (err instanceof Anthropic.APIUserAbortError || signal.aborted || gen !== this.gen) return;
    this.output.appendLine(`[error] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (err instanceof Anthropic.AuthenticationError) {
      this.notice("error", "Invalid API key. Run 'Agent Harness: Set API Key'.", gen);
    } else if (err instanceof Anthropic.RateLimitError) {
      this.notice("error", "Rate limited by the API. Wait a moment and try again.", gen);
    } else if (err instanceof Anthropic.APIError) {
      if (err.status === 400 && /too long|context window|exceed/i.test(err.message)) {
        this.notice("error", "This chat is too long for the model's context window. Start a New Chat.", gen);
      } else {
        this.notice("error", `API error${err.status ? ` ${err.status}` : ""}: ${err.message}`, gen);
      }
    } else {
      this.notice("error", `Error: ${err instanceof Error ? err.message : String(err)}`, gen);
    }
  }

  // ---- the loop ----

  private async runLoop(run: Run, client: Anthropic, root: string, s: Settings): Promise<void> {
    const { gen, signal, msgs } = run;
    const system = buildSystemPrompt(root);
    let retries = 0;

    while (!signal.aborted && gen === this.gen) {
      // Content block index -> UI item. Text/thinking items are created on the first delta so none are empty.
      const blockItem = new Map<number, { id: string; kind: "text" | "thinking"; created: boolean }>();
      const toolChars = new Map<number, { id: string; chars: number; at: number }>();
      const attemptTools: string[] = [];

      const params: Parameters<typeof client.beta.messages.stream>[0] = {
        model: s.model,
        max_tokens: s.maxTokens,
        system,
        tools: toolDefinitions,
        messages: msgs,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: s.effort },
        cache_control: { type: "ephemeral" },
        ...(s.refusalFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      };
      const stream = client.beta.messages.stream(params, { signal });

      stream.on("streamEvent", (ev) => {
        if (ev.type === "content_block_start") {
          const b = ev.content_block;
          if (b.type === "text" || b.type === "thinking") {
            blockItem.set(ev.index, { id: this.uid(b.type), kind: b.type, created: false });
          } else if (b.type === "tool_use") {
            toolChars.set(ev.index, { id: b.id, chars: 0, at: 0 });
            attemptTools.push(b.id);
            this.upsert({ kind: "tool", id: b.id, name: b.name, status: "streaming", inputChars: 0 }, gen);
          }
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta;
          if (d.type === "text_delta" || d.type === "thinking_delta") {
            const info = blockItem.get(ev.index);
            const piece = d.type === "text_delta" ? d.text : d.thinking;
            if (!info || !piece) return;
            if (!info.created) {
              info.created = true;
              this.upsert({ kind: info.kind, id: info.id, text: piece }, gen);
            } else {
              this.append(info.id, piece, gen);
            }
          } else if (d.type === "input_json_delta") {
            const t = toolChars.get(ev.index);
            if (!t) return;
            t.chars += d.partial_json.length;
            const now = Date.now();
            if (now - t.at >= INPUT_UPDATE_MS) {
              t.at = now;
              this.updateTool(t.id, { inputChars: t.chars }, gen);
            }
          }
        }
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return;
        if (err instanceof Anthropic.APIError) throw err;
        // Only the unparseable-tool-input case is retried; anything else is a real bug.
        const unparseable = err instanceof SyntaxError || /json/i.test(err instanceof Error ? err.message : "");
        if (unparseable && retries < MAX_RETRIES) {
          retries++;
          this.output.appendLine(`[retry ${retries}] ${err instanceof Error ? err.message : String(err)}`);
          for (const id of attemptTools) {
            this.updateTool(id, { status: "error", output: "Model sent invalid input; retrying." }, gen);
          }
          this.notice("info", "The model produced an invalid tool call. Retrying.", gen);
          continue;
        }
        throw err;
      }
      retries = 0;
      if (gen !== this.gen) return;

      const u = message.usage;
      this.output.appendLine(
        `[usage] input=${u.input_tokens} output=${u.output_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} stop=${message.stop_reason}`,
      );

      const content = message.content as unknown as Anthropic.Beta.BetaContentBlockParam[];
      const pushAssistant = () => {
        if (content.length > 0) msgs.push({ role: "assistant", content }); // empty content would 400
      };
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

      if (message.stop_reason === "refusal") {
        pushAssistant();
        const why = message.stop_details?.explanation;
        this.notice("error", `The model declined this request${why ? `: ${why}` : "."}`, gen);
        return;
      }
      if (message.stop_reason === "pause_turn") {
        pushAssistant();
        continue;
      }
      if (toolUses.length > 0 && message.stop_reason === "max_tokens") {
        // Not appended: it holds tool_use blocks that would need results.
        this.notice(
          "error",
          "The response was cut off (max tokens reached) before the tool call finished. Try again or raise agentHarness.maxTokens.",
          gen,
        );
        return;
      }
      if (toolUses.length === 0) {
        pushAssistant();
        if (message.stop_reason === "max_tokens") {
          this.notice("info", "The response was cut off (max tokens reached).", gen);
        }
        return;
      }

      // Keep the full assistant content (thinking blocks unchanged); answer every tool_use in one user message.
      msgs.push({ role: "assistant", content });
      const results = await this.runTools(run, toolUses, root, s);
      if (gen !== this.gen) return; // reset during tools: don't touch the new history
      msgs.push({ role: "user", content: results });
    }
  }

  /** Ask for every approval up front (so each card is answerable), then run the tools one at a time. */
  private async runTools(
    run: Run,
    toolUses: Anthropic.Beta.BetaToolUseBlock[],
    root: string,
    s: Settings,
  ): Promise<ToolResult[]> {
    const { gen, signal } = run;
    const plans = toolUses.map((tu) => {
      this.updateTool(tu.id, { input: tu.input }, gen);
      let input: unknown;
      let parseError: string | undefined;
      try {
        input = parseToolInput(tu.name, tu.input);
      } catch (e) {
        parseError = e instanceof ToolError ? e.message : String(e);
      }
      const needsApproval = !parseError && !signal.aborted && (MUTATING.has(tu.name) || !s.autoApproveReads);
      let approval: Promise<ApprovalResult> | undefined;
      if (needsApproval) {
        this.updateTool(tu.id, { status: "awaiting" }, gen);
        approval = this.approvals.request(tu.id, { signal, coverable: tu.name === "edit_file" || tu.name === "write_file" });
      }
      return { tu, input, parseError, approval };
    });

    const results: ToolResult[] = [];
    for (const { tu, input, parseError, approval } of plans) {
      const fail = (text: string, status: "error" | "rejected" = "error"): ToolResult => {
        this.updateTool(tu.id, { status, output: clip(text) }, gen);
        return { type: "tool_result", tool_use_id: tu.id, content: text, is_error: true };
      };
      if (parseError) {
        results.push(fail(parseError));
        continue;
      }
      if (signal.aborted) {
        results.push(fail("Stopped by user"));
        continue;
      }
      if (approval) {
        const decision = await approval;
        // "Approve all" was just chosen: release the other waiting cards too.
        if (this.approvals.approveAll) this.approvals.releaseCoverable();
        if (!decision.approved) {
          const why = decision.reason ? `: ${decision.reason}` : "";
          results.push(fail(`The user rejected this action${why}`, "rejected"));
          continue;
        }
        if (signal.aborted) {
          results.push(fail("Stopped by user"));
          continue;
        }
      }
      this.updateTool(tu.id, { status: "running" }, gen);
      try {
        const out = await runTool(tu.name, input, {
          root,
          signal,
          commandTimeoutSec: s.commandTimeoutSec,
          output: this.output,
        });
        this.updateTool(tu.id, { status: "done", output: clip(out) }, gen);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      } catch (e) {
        results.push(fail(e instanceof Error ? e.message : String(e)));
      }
    }
    return results;
  }
}
