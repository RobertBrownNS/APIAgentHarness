import type { AgentInfo, ChatItem, Effort, HostMessage } from "../../src/shared/protocol";
import { Team, type TeamSettings } from "../../src/team/team";
import type { AgentHandle, AgentOptions } from "../../src/team/types";

export type Ended = "done" | "stopped" | "error";
export interface Call {
  text: string;
  kind: "user" | "mail";
  /** End the turn. */
  finish(r?: { ended?: Ended; lastText?: string; error?: string }): void;
  done: boolean;
}

/** An AgentHandle whose turns end only when the test says so. `busy` is set synchronously in send(). */
export class FakeAgent implements AgentHandle {
  busy = false;
  transcript: ChatItem[] = [];
  calls: Call[] = [];
  paused = false;
  disposed = false;
  stopCount = 0;
  model: string;
  effort: Effort;
  tokens = 0;
  private current?: Call;
  constructor(public opts: AgentOptions) {
    this.model = opts.model;
    this.effort = opts.effort;
  }
  get name(): string {
    return this.opts.name;
  }
  info(): AgentInfo {
    return {
      name: this.name,
      isLead: this.opts.isLead,
      role: this.opts.role,
      model: this.model,
      effort: this.effort,
      status: this.disposed ? "stopped" : this.busy ? "running" : this.paused ? "paused" : "idle",
      spawnedBy: this.opts.spawnedBy,
      outputTokens: this.tokens,
      inputTokens: 0,
      pendingMail: 0,
    };
  }
  send(text: string, kind: "user" | "mail") {
    if (this.busy || this.disposed) return Promise.resolve({ ended: "done" as Ended, lastText: "" });
    this.busy = true;
    return new Promise<{ ended: Ended; lastText: string; error?: string }>((resolve) => {
      const call: Call = {
        text,
        kind,
        done: false,
        finish: (r = {}) => {
          if (call.done) return;
          call.done = true;
          this.busy = false;
          this.current = undefined;
          resolve({ ended: r.ended ?? "done", lastText: r.lastText ?? "ok", ...(r.error ? { error: r.error } : {}) });
        },
      };
      this.current = call;
      this.calls.push(call);
    });
  }
  stop(): void {
    this.stopCount++;
    this.current?.finish({ ended: "stopped" });
  }
  setModel(m: string): void {
    this.model = m;
  }
  setEffort(e: Effort): void {
    this.effort = e;
  }
  setPaused(p: boolean): void {
    this.paused = p;
  }
  dispose(): void {
    this.disposed = true;
    this.current?.finish({ ended: "stopped" });
  }
  get last(): Call {
    return this.calls[this.calls.length - 1];
  }
}

export const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
/** Let all pending microtasks and a macrotask run. */
export const flush = async () => {
  for (let i = 0; i < 3; i++) await tick();
};

export function makeTeam(over: Partial<TeamSettings> = {}) {
  const agents = new Map<string, FakeAgent>();
  const emitted: HostMessage[] = [];
  const settings: TeamSettings = {
    model: "claude-opus-5-5",
    effort: "high",
    teammateModel: "",
    maxTeammates: 5,
    maxAutoTurns: 40,
    maxTeamOutputTokens: 1_500_000,
    hasCredentials: true,
    ...over,
  };
  const team = new Team({
    root: "/ws",
    settings: () => settings,
    emit: (m) => emitted.push(m),
    createAgent: (o) => {
      const a = new FakeAgent(o);
      agents.set(o.name, a);
      return a;
    },
  });
  return { team, agents, emitted, settings, lead: agents.get("lead")! };
}
