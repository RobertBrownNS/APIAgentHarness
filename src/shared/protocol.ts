// Messages passed between the extension host and the chat webview.
// Imported by both builds, so keep this file free of runtime dependencies.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
] as const;

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
    }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string };

export interface SessionConfig {
  model: string;
  effort: Effort;
  hasCredentials: boolean;
  workspaceName?: string;
}

/** Extension host -> webview */
export type HostMessage =
  | { type: "snapshot"; items: ChatItem[]; busy: boolean; config: SessionConfig }
  | { type: "item"; item: ChatItem } // add, or replace the item with the same id
  | { type: "append"; id: string; text: string } // append to a text/thinking item
  | { type: "busy"; busy: boolean }
  | { type: "config"; config: SessionConfig };

export type ApprovalDecision = "approve" | "approveAll" | "reject";

/** Webview -> extension host */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "approval"; id: string; decision: ApprovalDecision; reason?: string }
  | { type: "setModel"; model: string }
  | { type: "setEffort"; effort: Effort }
  | { type: "setApiKey" };
