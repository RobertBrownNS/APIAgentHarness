// Interfaces shared between the team modules. Owner: manager (propose changes in TEAMS.md).
import type { AgentInfo, ApprovalRequest, ChatItem, Effort, Mode, TaskStatus, TeamTask } from "../shared/protocol";

/** Result of TeamContext.authorize for a file/command tool call. */
export interface Authorization {
  approved: boolean;
  /** Why it was refused (user's reason, "stopped", or the Plan-mode explanation). Goes into the tool_result. */
  reason?: string;
  /** Auto mode approved it without asking; short explanation shown on the tool card. */
  autoApproved?: string;
  /** Set when the current mode forbids the tool (Plan mode). */
  blockedByMode?: Mode;
}

/** Input to the Auto-mode safety check for a command. */
export interface CommandCheck {
  command: string;
  /** Absolute working directory (the workspace root today). */
  cwd: string;
  root: string;
  agent: string;
  /** For `npm|pnpm|yarn run <script>`: the script body from package.json, shown to the classifier as untrusted data. */
  scriptBody?: string;
}

/**
 * Auto-mode safety check (implemented in src/agent/classifier.ts with claude-haiku-5-5, injected into Team).
 * Must never throw: on any failure resolve { verdict: "ask", reason: "safety check unavailable: …" }.
 */
export type CommandClassifier = (
  check: CommandCheck,
  signal: AbortSignal,
) => Promise<{
  verdict: "allow" | "ask";
  reason: string;
  usage?: { input: number; output: number; uncachedInput: number; cacheRead: number; cacheWrite: number };
}>;

/**
 * Pure Auto-mode rules (src/team/autoPolicy.ts, no vscode/SDK imports). Allowlist-first (TEAMS.md R3 decisions):
 *   checkCommand(command, root, ctx: { written: ReadonlySet<string>; scriptBody?: (name: string) => string | undefined }):
 *     { verdict: "allow"; rule: string }      // recognised safe command, no expansion metacharacters
 *   | { verdict: "classify"; scriptBody?: string } // send to the classifier (never for anything with expansion chars)
 *   | { verdict: "ask"; rule: string }         // hard rule, expansion chars, runs a file written this session, inline code…
 *   isSensitivePath(absPath, root): boolean   // Windows-normalised; such edits always ask and are never coverable
 *   checkEdit(absPath, root): { verdict: "ask"; rule: string } | { verdict: "allow" }
 * The classifier can only turn "classify" into allow/ask; it never overrides "ask".
 */

// Team tool definitions + executors live in teamTools.ts (owner: core) and export:
//   teamToolDefinitions(isLead: boolean): Anthropic.Beta.BetaTool[]
//   isTeamTool(name: string): boolean
//   runTeamTool(name: string, input: unknown, ctx: { self: string; isLead: boolean; team: TeamContext }): Promise<string>
// loop.ts merges them with tools.ts definitions; team tools never need approval.

/** In-memory shared task list. Synchronous, so claims are atomic in the extension host. */
export interface TaskStore {
  create(input: { subject: string; description: string; blockedBy?: string[]; createdBy: string }): TeamTask;
  get(id: string): TeamTask | undefined;
  list(): TeamTask[];
  /**
   * Update a task. Throws TaskError (with a message suitable for the model) when:
   * the task doesn't exist; claiming (owner set, status in_progress) a task that is blocked or owned by
   * someone else; an unknown blockedBy id; a dependency cycle.
   * When `by` is "user" or "lead" the owned-by-someone-else check is skipped (they can reassign or release anything).
   * Completing a task removes it from other tasks' blockedBy.
   * Team (not TaskStore) sends mail: a waking "task N assigned to you" when owner changes to another agent, and a
   * passive "task N is unblocked" to the owners of tasks a completion unblocks.
   */
  update(
    id: string,
    patch: { status?: TaskStatus; owner?: string | null; addBlockedBy?: string[]; note?: string },
    by: string,
  ): TeamTask;
  /** Unassign every non-completed task owned by this agent (used when an agent is removed). */
  releaseOwner(agent: string): void;
  onChange(listener: (tasks: TeamTask[]) => void): () => void;
  clear(): void;
}

export interface MailMessage {
  from: string;
  to: string;
  text: string;
  /** Sent automatically when a teammate finishes a turn. */
  idle?: boolean;
  /** Sent to `all`. Delivered to every other agent but never wakes an idle one; read on its next turn. */
  broadcast?: boolean;
  /** Informational (e.g. "task 3 is now unblocked"); delivered without waking the recipient. */
  passive?: boolean;
}

/** Per-agent inboxes. Delivery wakes the recipient (handled by Team). */
export interface Mailbox {
  send(m: MailMessage): void;
  /** Remove and return everything waiting for this agent. */
  drain(agent: string): MailMessage[];
  pending(agent: string): number;
  onDeliver(listener: (m: MailMessage) => void): () => void;
  clear(): void;
}

/** Approval queue shared by every agent. */
export interface ApprovalQueue {
  request(req: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; reason?: string }>;
  resolve(id: string, decision: "approve" | "approveAll" | "reject", reason?: string): void;
  /** Reject everything waiting for this agent (Stop / remove). */
  cancelAgent(agent: string, reason: string): void;
  cancelAll(reason: string): void;
  pending(): ApprovalRequest[];
  onChange(listener: (pending: ApprovalRequest[]) => void): () => void;
  reset(): void;
}

/** What an AgentSession needs from its team. Implemented by Team. */
export interface TeamContext {
  readonly root: string;
  readonly tasks: TaskStore;
  readonly mailbox: Mailbox;
  readonly approvals: ApprovalQueue;
  /** Lead only: create a teammate. Throws TeamError on a bad name, a duplicate, or the size limit. */
  spawnTeammate(input: { name: string; role: string; prompt: string; model?: string; effort?: Effort }, by: string): AgentInfo;
  /** Lead or user: stop and remove a teammate. Releases its tasks. */
  removeTeammate(name: string, by: string): void;
  roster(): AgentInfo[];
  /** Serialise edits to the same file across agents. */
  withFileLock<T>(absPath: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Current team-wide mode. */
  readonly mode: Mode;
  /**
   * The single gate loop.ts calls before running edit_file / write_file / run_command (instead of approvals.request).
   * plan → refused (blockedByMode). normal → approval queue (approve-all coverage for edits).
   * auto → autoPolicy hard rules (ask with askReason) → edits allowed / commands to the classifier (allow or ask).
   * Read tools never call this unless autoApproveReads is off (then: normal/plan ask, auto allows).
   * `absPath` is the confined target for edit/write. Team records every path an agent writes (for the written-file rule).
   */
  authorize(
    req: { id: string; agent: string; tool: string; input: unknown; absPath?: string },
    signal: AbortSignal,
  ): Promise<Authorization>;
  /**
   * Re-check the CURRENT mode immediately before running a file/command tool (after approval, classifier and lock waits).
   * Closes races: approved in Normal then switched to Plan; batch authorized then mode changed; late classifier verdict.
   */
  canRun(
    tool: string,
    agent: string,
    /** tool_use id: lets Team refuse a call Auto approved once the mode is no longer Auto. */
    callId?: string,
  ): { ok: true } | { ok: false; reason: string; blockedByMode: Mode };
  /** Model ids a teammate can be given: Claude models plus Unsloth "local:<id>" models (shown by team_roster). */
  availableModels?(): string[];
  /** Called by loop after a successful edit_file/write_file so autoPolicy can apply the written-file rule. */
  recordWrite(agent: string, absPath: string): void;
  /**
   * Notes the agent must send as a mid-conversation `{role: "system"}` message right after its next user message
   * (tool_results or text), e.g. "Mode changed to Plan: …". Drained (removed) by the call.
   */
  drainSystemNotes(agent: string): string[];
  /** Main only, Plan mode only (present_plan tool): show the plan and wait for the user's decision. */
  presentPlan(
    req: { id: string; agent: string; title: string; summary: string; steps: { title: string; detail?: string }[] },
    signal: AbortSignal,
  ): Promise<{ approved: boolean; mode?: "normal" | "auto"; feedback?: string }>;
  /** Count an automatic (mail-triggered) turn. Returns false when the team's auto-turn budget is spent. */
  takeAutoTurn(agent: string): boolean;
  /**
   * Called by AgentSession before every model request and after every response with that response's usage.
   * Returns false when the team output-token budget (maxTeamOutputTokens) is spent: the agent must end the turn
   * (closing any tool_use with tool_results first) and Team pauses every agent with a notice.
   */
  recordUsage(
    agent: string,
    usage: {
      /** Total input incl. cache (for display). */
      input: number;
      output: number;
      /** Breakdown for the cost-weighted team budget. */
      uncachedInput: number;
      cacheRead: number;
      cacheWrite: number;
    },
  ): boolean;
  allowModelCall(agent: string): boolean;
}

/** Options for creating an AgentSession (src/agent/loop.ts). Team constructs one per agent. */
export interface AgentOptions {
  name: string;
  isLead: boolean;
  role: string;
  model: string;
  effort: Effort;
  spawnedBy: AgentInfo["spawnedBy"];
  team: TeamContext;
  events: AgentEvents;
}

/** What Team needs from an AgentSession. */
export interface AgentHandle {
  readonly name: string;
  readonly busy: boolean;
  readonly transcript: ChatItem[];
  info(): AgentInfo;
  /**
   * Start a turn. `kind: "user"` adds a user item; `kind: "mail"` adds the messages as `message` items are already
   * shown, so it only sends the formatted text to the model. Resolves when the turn (all loop iterations) ends.
   * Ignored (resolves immediately) while busy or stopped.
   */
  send(
    text: string,
    kind: "user" | "mail",
  ): Promise<{ ended: "done" | "stopped" | "error"; lastText: string; error?: string }>;
  /** Abort the current turn; the agent stays usable. */
  stop(): void;
  setModel(model: string): void;
  setEffort(effort: Effort): void;
  setPaused(paused: boolean): void;
  /** Permanently stop (status "stopped"). */
  dispose(): void;
}

/** Events an AgentSession reports; Team forwards them to the webview tagged with the agent name. */
export interface AgentEvents {
  item(item: ChatItem): void;
  append(id: string, text: string): void;
  info(info: AgentInfo): void;
}
