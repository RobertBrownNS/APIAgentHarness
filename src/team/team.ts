import {
  EFFORTS,
  LEAD,
  MODELS,
  type AgentInfo,
  type ApprovalDecision,
  type ChatItem,
  type Effort,
  type HostMessage,
  type SessionConfig,
  type TaskStatus,
  type TeamTask,
} from "../shared/protocol";
import { ApprovalQueueImpl } from "./approvalQueue";
import { withFileLock } from "./fileLock";
import { MailboxImpl } from "./mailbox";
import { TaskStoreImpl } from "./taskStore";
import type { AgentHandle, AgentOptions, MailMessage, TeamContext } from "./types";

export class TeamError extends Error {}

const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
const RESERVED = new Set([LEAD, "user", "all"]);
const IDLE_CLIP = 1500;
const MAX_MAIL = 4000;
const CONFIG_THROTTLE_MS = 500;
const SPAWN_EFFORT: Effort = "medium";

/** Settings the team reads each time it needs them (so changes apply to new agents and the budgets). */
export interface TeamSettings {
  model: string;
  effort: Effort;
  /** "" = same as the lead's model. */
  teammateModel: string;
  maxTeammates: number;
  maxAutoTurns: number;
  maxTeamOutputTokens: number;
  /** Read by the agent loop itself; accepted here so the panel can pass one settings object. */
  maxTurnIterations?: number;
  hasCredentials: boolean;
  workspaceName?: string;
}

export interface TeamOptions {
  root: string;
  settings: () => TeamSettings;
  /** Receives every HostMessage the team produces. */
  emit: (m: HostMessage) => void;
  /** Creates an agent. The panel passes `(o) => new AgentSession(o)`; tests pass fakes. */
  createAgent: (o: AgentOptions) => AgentHandle;
}

type PauseReason = "user" | "budget";

interface Slot {
  handle: AgentHandle;
  /** Input waiting to start a turn (a teammate's first prompt, or a user send to an idle agent). */
  inputs: { text: string; kind: "user" | "mail"; spawn?: boolean }[];
  /** User text already shown in the chat, waiting for the current turn to end. Runs first, before queued mail. */
  queued: string[];
  /** True while the pump loop is alive. The loop never awaits between its last check and clearing this. */
  pumping: boolean;
  paused?: PauseReason;
  removed: boolean;
}

export class Team implements TeamContext {
  readonly root: string;
  readonly tasks = new TaskStoreImpl();
  readonly mailbox = new MailboxImpl();
  readonly approvals = new ApprovalQueueImpl();

  private slots = new Map<string, Slot>();
  private autoTurnsLeft: number;
  private teamOutputTokens = 0;
  private budgetHit = false;
  private mailSeq = 1;
  private epoch = 0;
  private spawnCount = 0;
  private disposed = false;
  private unsubs: (() => void)[] = [];
  private configTimer?: ReturnType<typeof setTimeout>;
  private prevBlocked = new Map<string, number>();

  constructor(private readonly opts: TeamOptions) {
    this.root = opts.root;
    this.autoTurnsLeft = opts.settings().maxAutoTurns;
    this.unsubs.push(
      this.tasks.onChange((tasks) => this.onTasks(tasks)),
      this.approvals.onChange((approvals) => this.emit({ type: "approvals", approvals })),
      this.mailbox.onDeliver((m) => this.onMail(m)),
    );
    const s = opts.settings();
    this.addSlot({ name: LEAD, isLead: true, role: "", model: s.model, effort: s.effort, spawnedBy: "system" });
  }

  // ---- TeamContext ----

  withFileLock<T>(absPath: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withFileLock(absPath, fn, signal);
  }

  roster(): AgentInfo[] {
    return [...this.slots.values()].map((s) => this.decorate(s, s.handle.info()));
  }

  takeAutoTurn(_agent: string): boolean {
    if (this.autoTurnsLeft <= 0) return false;
    this.autoTurnsLeft--;
    this.scheduleConfig();
    return true;
  }

  allowModelCall(_agent: string): boolean {
    return !this.disposed && this.teamOutputTokens < this.opts.settings().maxTeamOutputTokens;
  }

  recordUsage(
    _agent: string,
    usage: { input: number; output: number; uncachedInput: number; cacheRead: number; cacheWrite: number },
  ): boolean {
    if (this.disposed) return false;
    // Output-equivalent tokens: input is weighted by its price relative to output.
    const n = (x: number) => Math.max(0, x || 0);
    this.teamOutputTokens += Math.round(
      n(usage.output) + 0.2 * (n(usage.uncachedInput) + 1.25 * n(usage.cacheWrite)) + 0.01 * n(usage.cacheRead),
    );
    this.scheduleConfig();
    if (this.teamOutputTokens < this.opts.settings().maxTeamOutputTokens) return true;
    if (!this.budgetHit) {
      this.budgetHit = true;
      for (const s of this.slots.values()) {
        if (s.removed || s.paused === "user") continue;
        this.pause(s, "budget");
        this.addNotice(s, "Team output-token budget reached. Send a message or press Resume to continue.");
      }
    }
    return false;
  }

  spawnTeammate(
    input: { name: string; role: string; prompt: string; model?: string; effort?: Effort },
    by: string,
  ): AgentInfo {
    if (this.disposed) throw new TeamError("The team has been closed.");
    if (by !== LEAD && by !== "user") throw new TeamError("Only the lead or the user can create teammates.");
    const name = input.name;
    if (!NAME_RE.test(name)) {
      throw new TeamError(`Invalid name "${name}": use 2-24 chars, lowercase letters, digits and dashes, starting with a letter.`);
    }
    if (RESERVED.has(name)) throw new TeamError(`"${name}" is a reserved name.`);
    if (this.slots.has(name)) throw new TeamError(`An agent named "${name}" already exists.`);
    const s = this.opts.settings();
    const active = this.roster().filter((r) => !r.isLead && r.status !== "stopped");
    if (active.length >= s.maxTeammates) {
      throw new TeamError(`The team already has the maximum of ${s.maxTeammates} teammates. Stop one first.`);
    }
    const role = (input.role ?? "").trim();
    if (!role) throw new TeamError("A teammate needs a role.");
    if (input.model !== undefined && !(MODELS as readonly string[]).includes(input.model)) {
      throw new TeamError(`Unknown model "${input.model}". Choose one of: ${MODELS.join(", ")}.`);
    }
    if (input.effort !== undefined && !EFFORTS.includes(input.effort)) {
      throw new TeamError(`Unknown effort "${String(input.effort)}". Choose one of: ${EFFORTS.join(", ")}.`);
    }
    if (this.spawnCount >= s.maxTeammates * 3) {
      throw new TeamError(`This team has already spawned ${this.spawnCount} teammates; start a new team instead of respawning.`);
    }
    // The first turn counts against the auto-turn budget, so spawn/stop cycles can't run unbounded.
    if ((input.prompt ?? "").trim() && !this.takeAutoTurn(by)) {
      throw new TeamError("The team's auto-turn budget is spent; ask the user to send a message or press Resume.");
    }
    const model = input.model ?? (s.teammateModel || s.model);
    const effort = input.effort ?? SPAWN_EFFORT;
    const slot = this.addSlot({ name, isLead: false, role, model, effort, spawnedBy: by === LEAD ? "lead" : "user" });
    this.spawnCount++;
    const lead = this.slots.get(LEAD);
    if (lead) this.addNotice(lead, `${by === LEAD ? "Spawned" : "User added"} teammate ${name} (${role}) on ${model}, effort ${effort}.`);
    const info = this.decorate(slot, slot.handle.info());
    this.emit({ type: "agent", agent: info });
    const prompt = (input.prompt ?? "").trim();
    if (prompt) {
      slot.inputs.push({ text: prompt, kind: "user", spawn: true });
      void this.pump(name);
    }
    return info;
  }

  removeTeammate(name: string, by: string): void {
    if (by !== LEAD && by !== "user") throw new TeamError("Only the lead or the user can remove teammates.");
    if (name === LEAD) throw new TeamError("The lead cannot be removed.");
    const slot = this.slots.get(name);
    if (!slot) throw new TeamError(`No agent named "${name}".`);
    if (slot.removed) return;
    slot.inputs.length = 0;
    slot.queued.length = 0;
    this.approvals.cancelAgent(name, "agent stopped");
    this.approvals.forgetAgent(name);
    // The agent's final "stopped" info and notice come through during dispose; everything after is dropped.
    slot.handle.dispose();
    this.addNotice(slot, by === LEAD ? "Stopped by the lead." : "Removed from the team.");
    slot.removed = true;
    this.tasks.releaseOwner(name);
    this.mailbox.drain(name);
    this.pushInfo(slot);
  }

  // ---- API for the panel ----

  /** Everything the webview needs to render from scratch. */
  snapshot(): HostMessage {
    const transcripts: Record<string, ChatItem[]> = {};
    for (const [n, s] of this.slots) transcripts[n] = [...s.handle.transcript];
    return {
      type: "snapshot",
      agents: this.roster(),
      transcripts,
      tasks: this.tasks.list(),
      approvals: this.approvals.pending(),
      config: this.config(),
    };
  }

  config(): SessionConfig {
    const s = this.opts.settings();
    return {
      model: s.model,
      effort: s.effort,
      teammateModel: s.teammateModel,
      hasCredentials: s.hasCredentials,
      workspaceName: s.workspaceName,
      maxTeammates: s.maxTeammates,
      autoTurnsLeft: this.autoTurnsLeft,
      maxAutoTurns: s.maxAutoTurns,
      teamOutputTokens: this.teamOutputTokens,
      maxTeamOutputTokens: s.maxTeamOutputTokens,
    };
  }

  /** Re-send the config now (call after settings or credentials change). */
  refreshConfig(): void {
    if (this.configTimer) clearTimeout(this.configTimer);
    this.configTimer = undefined;
    this.emit({ type: "config", config: this.config() });
  }

  /**
   * A user message to one agent. Refills the budgets (which unpauses budget-paused agents) and unpauses the target.
   * If the target is busy the text is shown now and runs as soon as its current turn ends.
   */
  send(agent: string, text: string): void {
    const slot = this.slots.get(agent);
    if (!slot || slot.removed || typeof text !== "string" || !text.trim()) return;
    this.refill();
    this.unpause(slot);
    if (slot.handle.busy || slot.pumping) {
      this.showItem(slot, { kind: "user", id: `qmsg-${this.mailSeq++}`, text });
      slot.queued.push(text);
    } else {
      slot.inputs.push({ text, kind: "user" });
    }
    void this.pump(agent);
  }

  /** Stop one agent's turn, or every agent's when omitted. Agents stay on the team, paused. */
  stop(agent?: string): void {
    const targets = agent ? [this.slots.get(agent)] : [...this.slots.values()];
    for (const s of targets) {
      if (!s || s.removed) continue;
      s.inputs.length = 0;
      s.queued.length = 0;
      this.approvals.forgetAgent(s.handle.name);
      s.handle.stop();
      this.approvals.cancelAgent(s.handle.name, "stopped by user");
      this.pause(s, "user");
    }
  }

  /** Unpause an agent and let its queued mail run. Refills the budgets like a user send. */
  resume(agent: string): void {
    const slot = this.slots.get(agent);
    if (!slot || slot.removed) return;
    this.refill();
    this.unpause(slot);
    void this.pump(agent);
  }

  approval(id: string, decision: ApprovalDecision, reason?: string): void {
    this.approvals.resolve(id, decision, reason);
  }

  addTeammate(input: { name: string; role: string; model?: string; effort?: Effort; prompt?: string }): AgentInfo {
    return this.spawnTeammate({ ...input, prompt: input.prompt ?? "" }, "user");
  }

  removeTeammateByUser(name: string): void {
    this.removeTeammate(name, "user");
  }

  setAgentModel(agent: string, model: string): void {
    const s = this.slots.get(agent);
    if (!s || s.removed || !(MODELS as readonly string[]).includes(model)) return;
    s.handle.setModel(model);
  }

  setAgentEffort(agent: string, effort: Effort): void {
    const s = this.slots.get(agent);
    if (!s || s.removed || !EFFORTS.includes(effort)) return;
    s.handle.setEffort(effort);
  }

  /** Throws TaskError with a readable message when the store refuses. */
  createTask(input: { subject: string; description: string; blockedBy?: string[] }): TeamTask {
    return this.tasks.create({ ...input, createdBy: "user" });
  }

  updateTask(id: string, patch: { status?: TaskStatus; owner?: string | null }): TeamTask {
    const before = this.tasks.get(id);
    if (patch.owner) {
      const s = this.slots.get(patch.owner);
      if (!s || s.removed) throw new TeamError(`No active agent named "${patch.owner}".`);
    }
    const t = this.tasks.update(id, patch, "user");
    if (t.owner && t.owner !== before?.owner) {
      this.mailbox.send({ from: "user", to: t.owner, text: `Task #${t.id} "${t.subject.slice(0, 80)}" was assigned to you.` });
    }
    return t;
  }

  /** Stops every agent and ignores any later callback. Create a new Team for a fresh start. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.configTimer) clearTimeout(this.configTimer);
    const old = [...this.slots.values()];
    this.slots.clear(); // detaches their events and makes their pump loops exit
    for (const s of old) {
      s.removed = true;
      s.inputs.length = 0;
      s.queued.length = 0;
      // Dispose while the agents' team context still works; one failure must not leave the others running.
      try {
        s.handle.dispose();
      } catch {
        /* keep going */
      }
    }
    this.epoch++;
    this.approvals.cancelAll("team was closed");
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  // ---- internals ----

  private emit(m: HostMessage): void {
    if (this.disposed) return;
    try {
      this.opts.emit(m);
    } catch {
      /* a broken panel must not break the team */
    }
  }

  private scheduleConfig(): void {
    if (this.configTimer || this.disposed) return;
    this.configTimer = setTimeout(() => {
      this.configTimer = undefined;
      this.emit({ type: "config", config: this.config() });
    }, CONFIG_THROTTLE_MS);
  }

  private decorate(slot: Slot, info: AgentInfo): AgentInfo {
    const out: AgentInfo = { ...info, pendingMail: this.mailbox.pending(info.name) };
    if (slot.paused && info.status !== "stopped") {
      out.pausedReason = slot.paused;
      if (info.status === "idle") out.status = "paused";
    } else {
      delete out.pausedReason;
    }
    return out;
  }

  private pushInfo(slot: Slot): void {
    this.emit({ type: "agent", agent: this.decorate(slot, slot.handle.info()) });
  }

  /** A view of this team for one agent. Once the team is closed, every call through it throws. */
  private contextFor(epoch: number): TeamContext {
    return new Proxy(this, {
      get: (t, p) => {
        if (t.epoch !== epoch && p !== "root") throw new Error("This team was closed; stop working.");
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  }

  private addSlot(o: Pick<AgentOptions, "name" | "isLead" | "role" | "model" | "effort" | "spawnedBy">): Slot {
    const name = o.name;
    const holder: { slot?: Slot } = {};
    // Events from an agent that was removed or replaced are dropped.
    const live = () => holder.slot !== undefined && this.slots.get(name) === holder.slot && !holder.slot.removed && !this.disposed;
    const handle = this.opts.createAgent({
      ...o,
      team: this.contextFor(this.epoch),
      events: {
        item: (item) => {
          if (live()) this.emit({ type: "item", agent: name, item });
        },
        append: (id, text) => {
          if (live()) this.emit({ type: "append", agent: name, id, text });
        },
        info: (info) => {
          if (live()) this.emit({ type: "agent", agent: this.decorate(holder.slot!, info) });
        },
      },
    });
    const slot: Slot = { handle, inputs: [], queued: [], pumping: false, removed: false };
    holder.slot = slot;
    this.slots.set(name, slot);
    return slot;
  }

  private pause(slot: Slot, reason: PauseReason): void {
    slot.paused = reason;
    slot.handle.setPaused(true);
    this.pushInfo(slot);
  }

  private unpause(slot: Slot): void {
    if (!slot.paused) return;
    slot.paused = undefined;
    slot.handle.setPaused(false);
    this.pushInfo(slot);
  }

  /** Budgets are full again: unpause budget-paused agents and run whatever is waiting for them. */
  private refill(): void {
    this.autoTurnsLeft = this.opts.settings().maxAutoTurns;
    this.teamOutputTokens = 0;
    this.budgetHit = false;
    this.scheduleConfig();
    for (const [n, s] of this.slots) {
      if (s.removed || s.paused !== "budget") continue;
      this.unpause(s);
      void this.pump(n);
    }
  }

  private onTasks(tasks: TeamTask[]): void {
    this.emit({ type: "tasks", tasks });
    // Tell owners (without waking them) when their task stops being blocked.
    for (const t of tasks) {
      const before = this.prevBlocked.get(t.id) ?? 0;
      if (before > 0 && t.blockedBy.length === 0 && t.status !== "completed" && t.owner && this.slots.get(t.owner)) {
        this.mailbox.send({ from: "system", to: t.owner, text: `Task #${t.id} "${t.subject.slice(0, 80)}" is no longer blocked.`, passive: true });
      }
    }
    this.prevBlocked = new Map(tasks.map((t) => [t.id, t.blockedBy.length]));
  }

  private onMail(m: MailMessage): void {
    const to = this.slots.get(m.to);
    const from = this.slots.get(m.from);
    if (!to || to.removed) return;
    const item = (): ChatItem => ({
      kind: "message",
      id: `mail-${this.mailSeq++}`,
      from: m.from,
      to: m.to,
      text: m.text,
      ...(m.idle ? { idle: true } : {}),
    });
    // Idle reports show only in the lead's chat; ordinary messages show in both chats.
    if (from && !from.removed && !m.idle && m.from !== m.to) this.showItem(from, item());
    this.showItem(to, item());
    this.pushInfo(to);
    // Broadcast and passive mail are delivered but wake nobody; it is read at the recipient's next turn.
    if (!m.broadcast && !m.passive) void this.pump(m.to);
  }

  private showItem(slot: Slot, item: ChatItem): void {
    slot.handle.transcript.push(item);
    this.emit({ type: "item", agent: slot.handle.name, item });
  }

  private addNotice(slot: Slot, text: string): void {
    this.showItem(slot, { kind: "notice", id: `mail-${this.mailSeq++}`, level: "info", text });
  }

  private formatMail(msgs: MailMessage[]): string {
    return msgs
      .map((m) => {
        const clipped = m.text.length > MAX_MAIL ? `${m.text.slice(0, MAX_MAIL)}... (clipped)` : m.text;
        // Neutralise anything that looks like a message tag so an agent can't forge a sender.
        const body = clipped.replace(/<(\/?)teammate-message/gi, "<\\$1teammate-message");
        return `<teammate-message from="${m.from}"${m.idle ? ' idle="true"' : ""}>${body}</teammate-message>`;
      })
      .join("\n");
  }

  private drainMail(name: string): string {
    const text = this.formatMail(this.mailbox.drain(name));
    const slot = this.slots.get(name);
    if (slot) this.pushInfo(slot);
    return text;
  }

  /**
   * The only place turns start. One loop per agent: queued user text first, then user input, then mail, until
   * nothing is left. Nothing awaits between the final "is there work?" check and clearing `pumping`, so mail
   * that arrives during a turn is seen by the loop, and mail that arrives after it ends starts a new loop.
   */
  private async pump(name: string): Promise<void> {
    const slot = this.slots.get(name);
    if (!slot || slot.pumping) return;
    slot.pumping = true;
    try {
      while (!this.disposed && !slot.removed && this.slots.get(name) === slot) {
        if (slot.handle.busy) break;
        let text: string;
        let kind: "user" | "mail";
        // A turn the user started directly is watched by the user: its idle report must not wake the lead.
        let userTurn = false;
        if (slot.queued.length) {
          userTurn = true;
          // The user items are already shown: send them first, then any waiting mail, as one message.
          const mail = this.mailbox.pending(name) ? `\n\n${this.drainMail(name)}` : "";
          text = slot.queued.splice(0).join("\n\n") + mail;
          kind = "mail";
        } else if (slot.inputs.length) {
          const next = slot.inputs.shift()!;
          ({ text, kind } = next);
          userTurn = !next.spawn;
        } else {
          if (slot.paused || this.mailbox.pending(name) === 0) break;
          if (!this.takeAutoTurn(name)) {
            this.pause(slot, "budget");
            this.addNotice(slot, "Auto-turn limit reached; mail is waiting. Send a message or press Resume to continue.");
            break;
          }
          text = this.drainMail(name);
          kind = "mail";
        }
        let res: { ended: "done" | "stopped" | "error"; lastText: string; error?: string };
        try {
          res = await slot.handle.send(text, kind);
        } catch (e) {
          res = { ended: "error", lastText: "", error: e instanceof Error ? e.message : String(e) };
        }
        if (!slot.handle.info().isLead && res.ended !== "stopped" && !slot.removed && this.slots.get(name) === slot) {
          this.reportIdle(name, res, userTurn);
        }
      }
    } finally {
      slot.pumping = false;
    }
  }

  private reportIdle(name: string, res: { ended: "done" | "error" | "stopped"; lastText: string; error?: string }, passive: boolean): void {
    const lead = this.slots.get(LEAD);
    if (!lead || lead.removed) return;
    let text = res.lastText.trim() || "(no text in the last reply)";
    if (text.length > IDLE_CLIP) text = `${text.slice(0, IDLE_CLIP)}... (clipped)`;
    if (res.ended === "error") text = `turn ended with an error: ${res.error ?? "unknown error"}${res.lastText.trim() ? `\n${text}` : ""}`;
    // One unread report per teammate: a newer one replaces the older.
    this.mailbox.removeWhere(LEAD, (x) => x.idle === true && x.from === name);
    this.mailbox.send({ from: name, to: LEAD, text, idle: true, ...(passive ? { passive: true } : {}) });
  }
}
