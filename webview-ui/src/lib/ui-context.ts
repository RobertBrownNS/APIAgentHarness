import { createContext } from "react";
import type { ApprovalRequest } from "@shared/protocol";

export interface ApprovalsCtx {
  /** Solo layout: approvals render inline in the chat. Team layout: they live in the shared queue. */
  inline: boolean;
  byId: Record<string, ApprovalRequest>;
  showQueue: () => void;
}

export const ApprovalsContext = createContext<ApprovalsCtx>({ inline: false, byId: {}, showQueue: () => {} });
