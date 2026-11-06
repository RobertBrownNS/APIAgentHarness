import type { AgentInfo, ApprovalRequest, ChatItem, HostMessage, SessionConfig, TeamTask } from "@shared/protocol";
import { LEAD } from "@shared/protocol";

export interface State {
  agents: AgentInfo[];
  transcripts: Record<string, ChatItem[]>;
  tasks: TeamTask[];
  approvals: ApprovalRequest[];
  config: SessionConfig;
  selected: string;
  /** New items per agent since it was last viewed. */
  unread: Record<string, number>;
  loaded: boolean;
}

export type Action = HostMessage | { type: "select"; agent: string };

export const initialState: State = {
  agents: [],
  transcripts: {},
  tasks: [],
  approvals: [],
  config: { model: "", effort: "medium", teammateModel: "", hasCredentials: true,
    maxTeammates: 0,
    mode: "normal",
    contextWindow: 1_000_000,
    autoTurnsLeft: 0,
    maxAutoTurns: 0,
    teamOutputTokens: 0,
    maxTeamOutputTokens: 0,
  },
  selected: LEAD,
  unread: {},
  loaded: false,
};

const EMPTY: ChatItem[] = [];

function bump(state: State, agent: string): Record<string, number> {
  if (agent === state.selected) return state.unread;
  return { ...state.unread, [agent]: (state.unread[agent] ?? 0) + 1 };
}

export function reducer(state: State, msg: Action): State {
  switch (msg.type) {
    case "select":
      if (msg.agent === state.selected && !state.unread[msg.agent]) return state;
      return { ...state, selected: msg.agent, unread: { ...state.unread, [msg.agent]: 0 } };
    case "snapshot": {
      const selected = msg.agents.some((a) => a.name === state.selected) ? state.selected : LEAD;
      return {
        agents: msg.agents,
        transcripts: msg.transcripts,
        tasks: msg.tasks,
        approvals: msg.approvals,
        config: msg.config,
        selected,
        unread: {},
        loaded: true,
      };
    }
    case "item": {
      const list = state.transcripts[msg.agent] ?? EMPTY;
      const i = list.findIndex((it) => it.id === msg.item.id);
      let next: ChatItem[];
      let unread = state.unread;
      if (i < 0) {
        next = [...list, msg.item];
        if (msg.item.kind === "text" || msg.item.kind === "message" || msg.item.kind === "notice") unread = bump(state, msg.agent);
      } else {
        next = list.slice();
        next[i] = msg.item;
      }
      return { ...state, transcripts: { ...state.transcripts, [msg.agent]: next }, unread };
    }
    case "append": {
      const list = state.transcripts[msg.agent];
      if (!list) return state;
      // Streaming targets the newest items, so search from the end.
      let i = list.length - 1;
      while (i >= 0 && list[i].id !== msg.id) i--;
      if (i < 0) return state;
      const it = list[i];
      if (it.kind !== "text" && it.kind !== "thinking") return state;
      const next = list.slice();
      next[i] = { ...it, text: it.text + msg.text };
      return { ...state, transcripts: { ...state.transcripts, [msg.agent]: next } };
    }
    case "agent": {
      const i = state.agents.findIndex((a) => a.name === msg.agent.name);
      const agents = state.agents.slice();
      if (i < 0) agents.push(msg.agent);
      else agents[i] = msg.agent;
      return { ...state, agents };
    }
    case "tasks":
      return { ...state, tasks: msg.tasks };
    case "approvals":
      return { ...state, approvals: msg.approvals };
    case "config":
      return { ...state, config: msg.config };
    default:
      return state;
  }
}
