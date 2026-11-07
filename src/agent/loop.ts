import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import * as vscode from "vscode";
import { isLocalModel, localModelId, type AgentInfo, type AgentStatus, type ChatItem, type Effort, type Mode } from "../shared/protocol";
import type { AgentEvents, AgentHandle, AgentOptions, Authorization, TeamContext } from "../team/types";
import { isTeamTool, runTeamTool, teamToolDefinitions } from "../team/teamTools";
import { appendUserTurn, systemNotesToText } from "./history";
import { globNamesSecrets } from "../team/autoPolicy";
import { isSecretEither, pathForAuthorize } from "./secretPaths";
import { createClient } from "./client";
import { confinePath } from "./paths";
import { buildLeadPrompt, buildTeammatePrompt } from "./systemPrompt";
import { MUTATING, parseToolInput, runTool, ToolError, toolDefinitions } from "./tools";

type Msg = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** Extension-wide services every AgentSession needs. Call once from activate(). */
export interface AgentRuntime {
  secrets: vscode.SecretStorage;
  output: vscode.OutputChannel;
}
let runtime: AgentRuntime | undefined;
export function configureAgentRuntime(r: AgentRuntime): void {
  runtime = r;
}

interface Settings {
  maxTokens: number;
  autoApproveReads: boolean;
  commandTimeoutSec: number;
  refusalFallback: boolean;
}

interface Run {
  signal: AbortSignal;
  msgs: Msg[];
  system: string;
  model: string;
  effort: Effort;
}

const MAX_UI_OUTPUT = 20_000;
const MAX_RETRIES = 2;
const INPUT_UPDATE_MS = 100;

function cfgGet<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration("nextAgent").get<T>(key, def);
}

function clip(s: string): string {
  return s.length > MAX_UI_OUTPUT
    ? `${s.slice(0, MAX_UI_OUTPUT)}\n... (${s.length - MAX_UI_OUTPUT} more characters not shown)`
    : s;
}

class ModeBlocked extends Error {
  constructor(
    message: string,
    readonly mode: Mode,
  ) {
    super(message);
  }
}

/** One team member: message history sent to the API plus the transcript shown in the panel. */
export class AgentSession implements AgentHandle {
  readonly name: string;
  private readonly isLead: boolean;
  private readonly role: string;
  private readonly spawnedBy: AgentInfo["spawnedBy"];
  private readonly team: TeamContext;
  private readonly events: AgentEvents;
  private model: string;
  private effort: Effort;

  private messages: Msg[] = [];
  private items: ChatItem[] = [];
  private abort?: AbortController;
  private _busy = false;
  private paused = false;
  private disposed = false;
  private pendingApprovals = 0;
  private outputTokens = 0;
  private inputTokens = 0;
  private contextTokens = 0;
  private notesAsText = false;
  /** Mode notes go as text for local models (Unsloth's API doesn't document role: "system" messages) or after a 400. */
  private notesTextMode(): boolean {
    return this.notesAsText || isLocalModel(this.model);
  }
  private turnErrored = false;
  private errorText = "";
  private lastText = "";
  private nextId = 1;

  constructor(opts: AgentOptions) {
    this.name = opts.name;
    this.isLead = opts.isLead;
    this.role = opts.role;
    this.model = opts.model;
    this.effort = opts.effort;
    this.spawnedBy = opts.spawnedBy;
    this.team = opts.team;
    this.events = opts.events;
  }

  get busy(): boolean {
    return this._busy;
  }

  get transcript(): ChatItem[] {
    return this.items;
  }

  info(): AgentInfo {
    let status: AgentStatus = "idle";
    if (this.disposed) status = "stopped";
    else if (this._busy) status = this.pendingApprovals > 0 ? "awaiting" : "running";
    else if (this.paused) status = "paused";
    return {
      name: this.name,
      isLead: this.isLead,
      role: this.role,
      model: this.model,
      effort: this.effort,
      status,
      spawnedBy: this.spawnedBy,
      outputTokens: this.outputTokens,
      inputTokens: this.inputTokens,
      contextTokens: this.contextTokens,
      pendingMail: this.pendingMailSafe(),
    };
  }

  /** Queued notes (e.g. mode changes) to send as system messages right after the next user message. */
  private drainNotes(): string[] {
    try {
      return this.team.drainSystemNotes(this.name);
    } catch {
      return [];
    }
  }

  private pendingMailSafe(): number {
    try {
      return this.team.mailbox.pending(this.name);
    } catch {
      return 0; // team already closed
    }
  }

  private emitInfo(): void {
    try {
      this.events.info(this.info());
    } catch {
      /* team already closed */
    }
  }

  // ---- transcript helpers ----

  private uid(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private upsert(item: ChatItem): void {
    const i = this.items.findIndex((x) => x.id === item.id);
    if (i >= 0) this.items[i] = item;
    else this.items.push(item);
    this.events.item(item);
  }

  private append(id: string, text: string): void {
    const it = this.items.find((x) => x.id === id);
    if (!it || (it.kind !== "text" && it.kind !== "thinking")) return;
    it.text += text;
    this.events.append(id, text);
  }

  private notice(level: "info" | "error", text: string): void {
    if (level === "error") {
      this.turnErrored = true;
      this.errorText = text;
    }
    this.upsert({ kind: "notice", id: this.uid("notice"), level, text });
  }

  private updateTool(id: string, patch: Partial<ToolItem>): void {
    const it = this.items.find((x) => x.id === id);
    if (it?.kind === "tool") this.upsert({ ...it, ...patch });
  }

  private log(line: string): void {
    runtime?.output.appendLine(`[${this.name}] ${line}`);
  }

  // ---- public API ----

  stop(): void {
    if (!this._busy || !this.abort || this.abort.signal.aborted) return;
    this.abort.abort();
    this.team.approvals.cancelAgent(this.name, "stopped by user");
    this.notice("info", "Stopped.");
  }

  setModel(model: string): void {
    this.model = model;
    this.emitInfo();
  }

  setEffort(effort: Effort): void {
    this.effort = effort;
    this.emitInfo();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.emitInfo();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort?.abort();
    try {
      this.team.approvals.cancelAgent(this.name, "agent stopped");
    } catch {
      /* team already closed */
    }
    this.emitInfo();
  }

  async send(
    text: string,
    kind: "user" | "mail",
  ): Promise<{ ended: "done" | "stopped" | "error"; lastText: string; error?: string }> {
    if (this._busy || this.disposed || typeof text !== "string" || !text.trim()) {
      return { ended: "stopped", lastText: "" };
    }
    this._busy = true; // claim synchronously so a double send can't start two loops
    const abort = new AbortController();
    this.abort = abort;
    this.turnErrored = false;
    this.lastText = "";
    this.errorText = "";
    this.emitInfo();
    const msgs = this.messages;
    try {
      if (kind === "user") this.upsert({ kind: "user", id: this.uid("user"), text });

      if (!runtime) {
        this.notice("error", "Agent runtime is not configured.");
        return this.result(abort);
      }
      const base = await createClient(runtime.secrets, this.model);
      const client = base?.withOptions({ maxRetries: 5 }); // parallel agents hit 429/529 more often
      if (!client) {
        this.notice(
          "error",
          isLocalModel(this.model)
            ? "No Unsloth API key found. Create one in Unsloth (Settings → API), then run 'NextAgent: Set Local Model Key'."
            : "No API key found. Run 'NextAgent: Set API Key'.",
        );
        return this.result(abort);
      }
      if (abort.signal.aborted) return this.result(abort);

      appendUserTurn(msgs, text, this.drainNotes(), this.notesTextMode()); // merges into a trailing user message after Stop or an API error

      const settings: Settings = {
        maxTokens: cfgGet<number>("maxTokens", 64000),
        autoApproveReads: cfgGet<boolean>("autoApproveReads", true),
        commandTimeoutSec: cfgGet<number>("commandTimeoutSec", 120),
        refusalFallback: cfgGet<boolean>("refusalFallback", true),
      };
      const root = this.team.root;
      const system = this.isLead
        ? buildLeadPrompt(root)
        : buildTeammatePrompt(root, { name: this.name, role: this.role });
      await this.runLoop({ signal: abort.signal, msgs, system, model: this.model, effort: this.effort }, client, settings);
    } catch (err) {
      this.reportError(err, abort.signal);
    } finally {
      // Anything still in flight (after Stop or an error) is no longer running.
      for (const it of [...this.items]) {
        if (it.kind === "tool" && (it.status === "streaming" || it.status === "awaiting" || it.status === "running")) {
          this.upsert({ ...it, status: "error" });
        }
      }
      this.pendingApprovals = 0;
      this._busy = false;
      this.emitInfo();
    }
    return this.result(abort);
  }

  private result(abort: AbortController): { ended: "done" | "stopped" | "error"; lastText: string; error?: string } {
    const ended = abort.signal.aborted || this.disposed ? "stopped" : this.turnErrored ? "error" : "done";
    return { ended, lastText: this.lastText, ...(ended === "error" ? { error: this.errorText } : {}) };
  }

  private reportError(err: unknown, signal: AbortSignal): void {
    if (err instanceof Anthropic.APIUserAbortError || signal.aborted) return;
    this.log(`[error] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (isLocalModel(this.model)) {
      if (err instanceof Anthropic.APIConnectionError) {
        this.notice("error", "Can't reach Unsloth Desktop. Is it running with a model loaded? (Check nextAgent.local.baseUrl.)");
        return;
      }
      if (err instanceof Anthropic.AuthenticationError) {
        this.notice("error", "Unsloth rejected the API key. Create a new one in Unsloth (Settings → API) and run 'NextAgent: Set Local Model Key'.");
        return;
      }
      if (err instanceof Anthropic.NotFoundError) {
        this.notice("error", `Unsloth doesn't know the model "${localModelId(this.model)}", or its API isn't enabled. Load the model in Unsloth and pick it again.`);
        return;
      }
    }
    if (err instanceof Anthropic.AuthenticationError) {
      this.notice("error", "Invalid API key. Run 'NextAgent: Set API Key'.");
    } else if (err instanceof Anthropic.RateLimitError) {
      this.notice("error", "Rate limited by the API. This agent's turn ended; send it a message to continue.");
    } else if (err instanceof Anthropic.APIError) {
      if (err.status === 400 && /too long|context window|exceed/i.test(err.message)) {
        this.notice("error", "This chat is too long for the model's context window. Start a New Team.");
      } else {
        this.notice("error", `API error${err.status ? ` ${err.status}` : ""}: ${err.message}`);
      }
    } else {
      this.notice("error", `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- the loop ----

  private async runLoop(run: Run, client: Anthropic, s: Settings): Promise<void> {
    const { signal, msgs, system } = run;
    const tools = [...toolDefinitions, ...teamToolDefinitions(this.isLead)];
    let retries = 0;

    // 0 (the default) means no limit on model calls per turn.
    const cfgMax = cfgGet<number>("maxTurnIterations", 0);
    const maxIter = Number.isFinite(cfgMax) && cfgMax > 0 ? cfgMax : Infinity;
    let iter = 0;
    while (!signal.aborted) {
      if (iter++ >= maxIter) {
        this.lastText = `${this.lastText}
(turn stopped at the iteration limit; work may be incomplete)`.trim();
        this.notice("info", `Stopped after ${maxIter} model calls in one turn (nextAgent.maxTurnIterations).`);
        return;
      }
      // Content block index -> UI item. Text/thinking items are created on the first delta so none are empty.
      const blockItem = new Map<number, { id: string; kind: "text" | "thinking"; created: boolean }>();
      const toolChars = new Map<number, { id: string; chars: number; at: number }>();
      const attemptTools: string[] = [];

      if (!this.team.allowModelCall(this.name)) {
        this.notice("info", "Team budget reached; this turn ended.");
        return;
      }
      // model/effort are read per iteration so a change in the UI applies to the next request
      let stream: BetaMessageStream;
      if (isLocalModel(this.model)) {
        // Unsloth Desktop's Anthropic-compatible API: plain Messages request, no Claude-only fields (thinking, effort,
        // caching, fallback, eager tool streaming). enable_tools: false keeps Unsloth's own server-side tools from
        // swallowing the agent's tool calls.
        const localTools = tools.map((t) => {
          const { eager_input_streaming: _eager, ...rest } = t as Anthropic.Beta.BetaTool;
          return rest;
        });
        const body = {
          model: localModelId(this.model),
          max_tokens: cfgGet<number>("local.maxTokens", 8192),
          system,
          tools: localTools,
          messages: msgs,
          enable_tools: false,
        };
        stream = client.messages.stream(body as unknown as Parameters<typeof client.messages.stream>[0], {
          signal,
        }) as unknown as BetaMessageStream;
      } else {
        const params: Parameters<typeof client.beta.messages.stream>[0] = {
          model: this.model,
          max_tokens: s.maxTokens,
          system,
          tools,
          messages: msgs,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: this.effort },
          cache_control: { type: "ephemeral" },
          ...(s.refusalFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
        };
        stream = client.beta.messages.stream(params, { signal });
      }

      stream.on("streamEvent", (ev) => {
        if (ev.type === "content_block_start") {
          const b = ev.content_block;
          if (b.type === "text" || b.type === "thinking") {
            blockItem.set(ev.index, { id: this.uid(b.type), kind: b.type, created: false });
          } else if (b.type === "tool_use") {
            toolChars.set(ev.index, { id: b.id, chars: 0, at: 0 });
            attemptTools.push(b.id);
            this.upsert({ kind: "tool", id: b.id, name: b.name, status: "streaming", inputChars: 0 });
          }
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta;
          if (d.type === "text_delta" || d.type === "thinking_delta") {
            const info = blockItem.get(ev.index);
            const piece = d.type === "text_delta" ? d.text : d.thinking;
            if (!info || !piece) return;
            if (!info.created) {
              info.created = true;
              this.upsert({ kind: info.kind, id: info.id, text: piece });
            } else {
              this.append(info.id, piece);
            }
          } else if (d.type === "input_json_delta") {
            const t = toolChars.get(ev.index);
            if (!t) return;
            t.chars += d.partial_json.length;
            const now = Date.now();
            if (now - t.at >= INPUT_UPDATE_MS) {
              t.at = now;
              this.updateTool(t.id, { inputChars: t.chars });
            }
          }
        }
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return;
        if (err instanceof Anthropic.APIError) {
          // Safety net: if the API rejects mid-conversation system messages, send notes as text from now on.
          if (err.status === 400 && !this.notesAsText && /system/i.test(err.message)) {
            this.notesAsText = true; // once only; a repeat 400 is reported as an error
            if (systemNotesToText(msgs) > 0) {
              this.log("[notes] API rejected role:system messages; falling back to text notes");
              continue;
            }
          }
          throw err;
        }
        // Only the unparseable-tool-input case is retried; anything else is a real bug.
        const unparseable = err instanceof SyntaxError || /json/i.test(err instanceof Error ? err.message : "");
        if (unparseable && retries < MAX_RETRIES) {
          retries++;
          this.log(`[retry ${retries}] ${err instanceof Error ? err.message : String(err)}`);
          for (const id of attemptTools) {
            this.updateTool(id, { status: "error", output: "Model sent invalid input; retrying." });
          }
          this.notice("info", "The model produced an invalid tool call. Retrying.");
          continue;
        }
        throw err;
      }
      retries = 0;

      const u = message.usage;
      this.outputTokens += u.output_tokens ?? 0;
      const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      this.inputTokens += inTok;
      this.contextTokens = inTok;
      const withinBudget = this.team.recordUsage(this.name, {
        input: inTok,
        output: u.output_tokens ?? 0,
        uncachedInput: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      });
      this.emitInfo();
      this.log(
        `[usage] input=${u.input_tokens} output=${u.output_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} stop=${message.stop_reason}`,
      );

      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      this.lastText = text;

      const content = message.content as unknown as Anthropic.Beta.BetaContentBlockParam[];
      const pushAssistant = () => {
        if (content.length > 0) msgs.push({ role: "assistant", content }); // empty content would 400
      };
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

      if (message.stop_reason === "refusal") {
        pushAssistant();
        const why = message.stop_details?.explanation;
        this.notice("error", `The model declined this request${why ? `: ${why}` : "."}`);
        return;
      }
      if (message.stop_reason === "pause_turn") {
        pushAssistant();
        if (!withinBudget) {
          this.notice("info", "Team budget reached; this turn ended.");
          return;
        }
        continue;
      }
      if (toolUses.length > 0 && message.stop_reason === "max_tokens") {
        // Not appended: it holds tool_use blocks that would need results.
        this.notice(
          "error",
          "The response was cut off (max tokens reached) before the tool call finished. Try again or raise nextAgent.maxTokens.",
        );
        return;
      }
      if (toolUses.length === 0) {
        pushAssistant();
        if (message.stop_reason === "max_tokens") {
          this.notice("info", "The response was cut off (max tokens reached).");
        }
        return;
      }

      // Keep the full assistant content (thinking blocks unchanged); answer every tool_use in one user message.
      msgs.push({ role: "assistant", content });
      if (!withinBudget) {
        // Close every tool_use without running it so the history stays valid.
        const stub: ToolResult[] = toolUses.map((tu) => {
          this.updateTool(tu.id, { status: "error", output: "Not run: team budget reached." });
          return { type: "tool_result", tool_use_id: tu.id, content: "Not run: the team budget was reached.", is_error: true };
        });
        appendUserTurn(msgs, stub, this.drainNotes(), this.notesTextMode());
        this.notice("info", "Team budget reached; this turn ended.");
        return;
      }
      const results = await this.runTools(run, toolUses, s);
      appendUserTurn(msgs, results, this.drainNotes(), this.notesTextMode());
    }
  }

  /** Ask for every approval up front (so each card is answerable), then run the tools one at a time. */
  private async runTools(
    run: Run,
    toolUses: Anthropic.Beta.BetaToolUseBlock[],
    s: Settings,
  ): Promise<ToolResult[]> {
    const { signal } = run;
    const root = this.team.root;
    const plans = toolUses.map((tu) => {
      this.updateTool(tu.id, { input: tu.input });
      const teamTool = isTeamTool(tu.name);
      let input: unknown;
      let parseError: string | undefined;
      if (teamTool) {
        input = tu.input; // validated by runTeamTool
      } else {
        try {
          input = parseToolInput(tu.name, tu.input);
        } catch (e) {
          parseError = e instanceof ToolError ? e.message : String(e);
        }
      }
      // Reads of secret files (.env, keys, .ssh ...) always go through authorize, even with autoApproveReads on.
      let secretRead = false;
      if (!teamTool && !parseError) {
        const inp = input as { path?: string; glob?: string };
        if (tu.name === "read_file" && typeof inp.path === "string") {
          try {
            secretRead = isSecretEither(confinePath(root, inp.path), root);
          } catch {
            /* runTool reports the path error */
          }
        } else if ((tu.name === "list_files" || tu.name === "search_text") && globNamesSecrets(inp.glob)) {
          secretRead = true;
        }
      }
      const needsApproval =
        !teamTool && !parseError && !signal.aborted && (MUTATING.has(tu.name) || !s.autoApproveReads || secretRead);
      let approval: Promise<Authorization> | undefined;
      if (needsApproval) {
        // In Auto mode most calls are decided without the user, so only other modes show "awaiting" up front.
        const showAwaiting = this.team.mode !== "auto";
        if (showAwaiting) {
          this.updateTool(tu.id, { status: "awaiting" });
          this.pendingApprovals++;
          this.emitInfo();
        }
        let absPath: string | undefined;
        if (tu.name === "edit_file" || tu.name === "write_file" || tu.name === "read_file") {
          try {
            absPath = pathForAuthorize(confinePath(root, (input as { path: string }).path), root);
          } catch {
            /* runTool reports the path error */
          }
        }
        approval = this.team
          .authorize({ id: tu.id, agent: this.name, tool: tu.name, input, absPath }, signal)
          .catch((): Authorization => ({ approved: false, reason: "stopped" }))
          .finally(() => {
            if (!showAwaiting) return;
            this.pendingApprovals = Math.max(0, this.pendingApprovals - 1);
            this.emitInfo();
          });
      }
      return { tu, input, parseError, approval, teamTool };
    });

    const results: ToolResult[] = [];
    for (const { tu, input, parseError, approval, teamTool } of plans) {
      const fail = (text: string, status: "error" | "rejected" = "error"): ToolResult => {
        this.updateTool(tu.id, { status, output: clip(text) });
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
        if (!decision.approved) {
          if (decision.blockedByMode) {
            this.updateTool(tu.id, { blockedByMode: decision.blockedByMode });
            results.push(fail(decision.reason ?? `Refused: the team is in ${decision.blockedByMode} mode.`, "rejected"));
            continue;
          }
          const why = decision.reason ? `: ${decision.reason}` : "";
          results.push(fail(`The user rejected this action${why}`, "rejected"));
          continue;
        }
        if (decision.autoApproved) this.updateTool(tu.id, { autoApproved: decision.autoApproved });
        if (signal.aborted) {
          results.push(fail("Stopped by user"));
          continue;
        }
      }
      this.updateTool(tu.id, { status: "running" });
      try {
        const out = teamTool
          ? await runTeamTool(tu.name, input, {
              self: this.name,
              isLead: this.isLead,
              team: this.team,
              toolUseId: tu.id,
              signal,
            })
          : await this.runFileOrCommand(tu.name, input, root, signal, s, tu.id);
        this.updateTool(tu.id, { status: "done", output: clip(out) });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      } catch (e) {
        if (e instanceof ModeBlocked) {
          this.updateTool(tu.id, { blockedByMode: e.mode });
          results.push(fail(e.message, "rejected"));
          continue;
        }
        results.push(fail(e instanceof Error ? e.message : String(e)));
      }
    }
    return results;
  }

  private runFileOrCommand(name: string, input: unknown, root: string, signal: AbortSignal, s: Settings, callId: string): Promise<string> {
    const exec = () => {
      if (MUTATING.has(name)) {
        const gate = this.team.canRun(name, this.name, callId);
        if (!gate.ok) throw new ModeBlocked(gate.reason, gate.blockedByMode);
      }
      return runTool(name, input, {
        root,
        signal,
        commandTimeoutSec: s.commandTimeoutSec,
        output: runtime!.output,
      });
    };
    if (name !== "edit_file" && name !== "write_file") return exec();
    // Serialise writes to the same file across agents.
    let abs: string;
    try {
      abs = confinePath(root, (input as { path: string }).path);
    } catch {
      return exec(); // runTool reports the path error itself
    }
    return this.team.withFileLock(
      abs,
      async () => {
        const out = await exec();
        this.team.recordWrite(this.name, abs);
        return out;
      },
      signal,
    );
  }
}
