// NextAgent: messages passed between the extension host and the chat webview (protocol v3: teams + modes).
// Imported by both builds, so keep this file free of runtime dependencies.
// Owner: manager. Propose changes in TEAMS.md "Contract changes" and message the manager.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
] as const;

/** The main (lead) agent always has this name. */
export const LEAD = "main";
/** Names teammates may not use. */
export const RESERVED_NAMES = ["main", "lead", "user", "all", "system"] as const;

/**
 * Team-wide permission mode.
 * plan:   read/search/message/tasks only; edits and commands are refused; main presents a plan for approval.
 * normal: edits and commands ask in the approval queue ("Approve all edits" per agent still works).
 * auto:   edits inside the workspace run; commands run unless a hard rule or the safety check says ask.
 * ultra:  everything runs without asking or a safety check, except a tiny backstop: deleting/moving/writing
 *         outside the workspace, force-pushing or deleting remote git history, disk/OS-level commands, and
 *         reading secret files. Never a default; switching to it always needs the user's confirmation.
 */
export type Mode = "plan" | "normal" | "auto" | "ultra";
export const MODES: Mode[] = ["plan", "normal", "auto", "ultra"];

export interface PlanStep {
  title: string;
  detail?: string;
}

export type ToolStatus =
  | "streaming" // model is still writing the tool input
  | "awaiting" // waiting for the user to approve
  | "running"
  | "done"
  | "error"
  | "rejected";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input?: unknown;
      inputChars?: number;
      status: ToolStatus;
      output?: string;
      /** Set when Auto mode approved this call without asking: "rule" text or the safety check's reason. */
      autoApproved?: string;
      /** Set when Plan mode refused this call. */
      blockedByMode?: Mode;
    }
  /** A plan presented by main (present_plan). Mirrors the pending plan approval while it waits. */
  | {
      kind: "plan";
      id: string; // the tool_use id
      title: string;
      summary: string;
      steps: PlanStep[];
      status: "awaiting" | "approved" | "rejected";
      /** Mode chosen on approval, or the user's feedback on rejection. */
      approvedMode?: Exclude<Mode, "plan">;
      feedback?: string;
    }
  /** A team-wide mode change, shown as a marker in every agent's chat. */
  | { kind: "mode"; id: string; mode: Mode; by: string }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string }
  /** A message between agents (or from the user to an agent). Shown in both agents' chats. */
  | { kind: "message"; id: string; from: string; to: string; text: string; idle?: boolean };

export type AgentStatus =
  | "idle" // waiting for input
  | "running" // a turn is in progress
  | "awaiting" // a turn is blocked on the user's approval
  | "paused" // stopped by the user, or a team budget ran out; resumes when the user sends to it or presses Resume
  | "stopped"; // removed from the team by the lead or the user; can't be restarted

export interface AgentInfo {
  name: string;
  isLead: boolean;
  /** One-line role, e.g. "Writes unit tests". Empty for the lead. */
  role: string;
  model: string;
  effort: Effort;
  status: AgentStatus;
  /** Why it is paused: the user stopped it (stays paused until resumed or sent to), or a team budget ran out
   *  (unpaused automatically when the user's next message refills the budgets). */
  pausedReason?: "user" | "budget";
  /** Who created it: the lead agent (via spawn_teammate) or the user (from the UI). */
  spawnedBy: "lead" | "user" | "system";
  /** Output tokens used so far, for a rough cost indicator. */
  outputTokens: number;
  /** Input tokens used so far, including cache reads and writes. */
  inputTokens: number;
  /** Messages queued for this agent and not yet delivered. */
  pendingMail: number;
  /** Input tokens (incl. cache) of this agent's most recent request: how full its context window is. */
  contextTokens: number;
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TeamTask {
  id: string; // "1", "2", ...
  subject: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  /** Ids of tasks that must be completed first. Only lists ones not yet completed. */
  blockedBy: string[];
  createdBy: string;
  notes: { by: string; text: string }[];
}

export interface ApprovalRequest {
  /** The tool_use id. */
  id: string;
  agent: string;
  /** "tool": approve/reject a tool call. "plan": approve main's plan (choosing normal or auto) or send feedback. */
  kind: "tool" | "plan";
  tool: string;
  input: unknown;
  /** True for file edits/writes, which "Approve all edits" for that agent may cover. */
  coverable: boolean;
  /** Auto mode: why this call still needs you (hard rule hit or the safety check's reason). */
  askReason?: string;
}

export interface SessionConfig {
  /** Defaults used for the lead and for new teammates when no model/effort is given. */
  model: string;
  effort: Effort;
  teammateModel: string;
  hasCredentials: boolean;
  workspaceName?: string;
  maxTeammates: number;
  /** Team-wide permission mode. */
  mode: Mode;
  /** Context window of the model, for the context meter (1_000_000 for current models). */
  contextWindow: number;
  /** Team budgets. Both refill whenever the user sends a message. Re-sent (throttled) when they change. */
  autoTurnsLeft: number;
  maxAutoTurns: number;
  teamOutputTokens: number;
  maxTeamOutputTokens: number;
}

/** Extension host -> webview */
export type HostMessage =
  | {
      type: "snapshot";
      agents: AgentInfo[];
      transcripts: Record<string, ChatItem[]>;
      tasks: TeamTask[];
      approvals: ApprovalRequest[];
      config: SessionConfig;
    }
  | { type: "item"; agent: string; item: ChatItem } // add, or replace the item with the same id
  | { type: "append"; agent: string; id: string; text: string } // append to a text/thinking item
  | { type: "agent"; agent: AgentInfo } // add or replace by name
  | { type: "tasks"; tasks: TeamTask[] } // full list
  | { type: "approvals"; approvals: ApprovalRequest[] } // full pending queue, oldest first
  | { type: "config"; config: SessionConfig };

export type ApprovalDecision = "approve" | "approveAll" | "reject";

/** Webview -> extension host */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; agent: string; text: string }
  /** Stop one agent's current turn (or every agent's when omitted); it becomes "paused". Agents stay on the team. */
  | { type: "stop"; agent?: string }
  /** Unpause an agent; it picks up queued mail. Refills the team budgets like a user send. */
  | { type: "resume"; agent: string }
  /** Stop everything and start an empty team with a fresh lead. */
  | { type: "newTeam" }
  | { type: "approval"; id: string; decision: ApprovalDecision; reason?: string }
  | { type: "setMode"; mode: Mode }
  /** Answer main's plan: approve (switching the team to `mode`) or reject with feedback (stays in plan mode). */
  | { type: "planDecision"; id: string; approve: boolean; mode?: Exclude<Mode, "plan">; feedback?: string }
  | { type: "addTeammate"; name: string; role: string; model?: string; effort?: Effort }
  | { type: "removeTeammate"; name: string }
  | { type: "setAgentModel"; agent: string; model: string }
  | { type: "setAgentEffort"; agent: string; effort: Effort }
  | { type: "createTask"; subject: string; description: string; blockedBy?: string[] }
  | { type: "updateTask"; id: string; status?: TaskStatus; owner?: string | null }
  | { type: "setApiKey" };
