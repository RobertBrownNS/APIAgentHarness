import {
  EFFORTS,
  LEAD,
  MODELS,
  RESERVED_NAMES,
  type AgentInfo,
  type ApprovalDecision,
  type ChatItem,
  type Effort,
  type HostMessage,
  type Mode,
  type PlanStep,
  type SessionConfig,
  type TaskStatus,
  type TeamTask,
} from "../shared/protocol";
import { ApprovalQueueImpl } from "./approvalQueue";
import { withFileLock } from "./fileLock";
import { MailboxImpl } from "./mailbox";
import * as fs from "node:fs";
import * as path from "node:path";
import { ultraBackstop, checkCommand, checkEdit, globNamesSecrets, isSecretPath, isSensitivePath, normalizePath, packageJsonRisk, writeTargets } from "./autoPolicy";
import { TaskStoreImpl } from "./taskStore";
import type { AgentHandle, AgentOptions, Authorization, CommandClassifier, MailMessage, TeamContext } from "./types";

export class TeamError extends Error {}

function isInsideRoot(target: string, root: string): boolean {
  const rel = path.relative(root, path.resolve(root, target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
const RESERVED = new Set<string>(RESERVED_NAMES);
const MUTATING_TOOLS = new Set(["edit_file", "write_file", "run_command"]);
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

const PLAN_REFUSAL =
  "Refused: the team is in Plan mode, so edits and commands are not allowed. Investigate with read-only tools, then main calls present_plan; edits and commands unlock once the user approves a plan.";

const MODE_NOTES: Record<Mode, string> = {
  plan: "Mode is now Plan. You may read, search, message teammates and manage tasks; edit_file, write_file and run_command will be refused. Main: investigate, then call present_plan with a concrete plan.",
  normal: "Mode is now Normal. Edits and commands need the user's approval.",
  auto: "Mode is now Auto. Edits run without asking; commands run unless a safety rule or check asks the user. Prefer safe, reversible steps.",
  ultra: "Mode is now Ultra: edits and commands run without asking except a few catastrophic actions. Prefer reversible steps and say what you're about to do.",
};

/** How strict a mode is: a call approved under a looser mode must not run after the team moves to a stricter one. */
const STRICTNESS: Record<Mode, number> = { ultra: 0, auto: 1, normal: 2, plan: 3 };
const IDLE_CLIP = 1500;
const MAX_MAIL = 4000;
const CONFIG_THROTTLE_MS = 500;
const SPAWN_EFFORT: Effort = "medium";

/** Settings the team reads each time it needs them (so changes apply to new agents and the budgets). */
export interface TeamSettings {
  model: string;
  effort: Effort;
  /** "" = same as main's model. */
  teammateModel: string;
  maxTeammates: number;
  maxAutoTurns: number;
  maxTeamOutputTokens: number;
  /** Read by the agent loop itself; accepted here so the panel can pass one settings object. */
  maxTurnIterations?: number;
  hasCredentials: boolean;
  workspaceName?: string;
  /** Mode a new team starts in (default "normal"). */
  defaultMode?: Mode;
  /** Auto mode: false = commands that pass the hard rules still ask (no classifier). */
  autoSafetyCheck?: boolean;
  /** For the context meter (default 1_000_000). */
  contextWindow?: number;
}

export interface TeamOptions {
  root: string;
  settings: () => TeamSettings;
  /** Receives every HostMessage the team produces. */
  emit: (m: HostMessage) => void;
  /** Creates an agent. The panel passes `(o) => new AgentSession(o)`; tests pass fakes. */
  createAgent: (o: AgentOptions) => AgentHandle;
  /** Auto-mode safety check (src/agent/classifier.ts). Without one, Auto asks for every command that passes the hard rules. */
  classify?: CommandClassifier;
  /** Receives log lines such as "[auto] agent: command - reason". */
  log?: (line: string) => void;
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
  private currentMode: Mode;
  private notes = new Map<string, string[]>();
  private plans = new Map<string, { mode?: "normal" | "auto"; feedback?: string }>();
  private written = new Set<string>();
  private startedAt = Date.now();
  /** package.json was edited this session (any edit). */
  private pkgChanged = false;
  /** package.json edits seen by authorize: normalised path -> what makes it risky (undefined = harmless). */
  private pkgRisk = new Map<string, string | undefined>();
  /** Tool calls approved by Auto mode that have not run yet (id -> true). canRun refuses them once Auto is off. */
  private autoApprovedIds = new Map<string, Mode>();

  constructor(private readonly opts: TeamOptions) {
    this.root = opts.root;
    this.autoTurnsLeft = opts.settings().maxAutoTurns;
    // Only Plan or Normal can be the starting mode; Auto and Ultra are explicit switches.
    this.currentMode = opts.settings().defaultMode === "plan" ? "plan" : "normal";
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
    // All limits are optional: 0 (the default) means unlimited.
    if (!(this.opts.settings().maxAutoTurns > 0)) return true;
    if (this.autoTurnsLeft <= 0) return false;
    this.autoTurnsLeft--;
    this.scheduleConfig();
    return true;
  }

  allowModelCall(_agent: string): boolean {
    const max = this.opts.settings().maxTeamOutputTokens;
    return !this.disposed && (!(max > 0) || this.teamOutputTokens < max);
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
    const max = this.opts.settings().maxTeamOutputTokens;
    if (!(max > 0) || this.teamOutputTokens < max) return true;
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
    if (by !== LEAD && by !== "user") throw new TeamError("Only main or the user can create teammates.");
    const name = input.name;
    if (!NAME_RE.test(name)) {
      throw new TeamError(`Invalid name "${name}": use 2-24 chars, lowercase letters, digits and dashes, starting with a letter.`);
    }
    if (RESERVED.has(name)) throw new TeamError(`"${name}" is a reserved name.`);
    if (this.slots.has(name)) throw new TeamError(`An agent named "${name}" already exists.`);
    const s = this.opts.settings();
    const active = this.roster().filter((r) => !r.isLead && r.status !== "stopped");
    if (s.maxTeammates > 0 && active.length >= s.maxTeammates) {
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
    if (s.maxTeammates > 0 && this.spawnCount >= s.maxTeammates * 3) {
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
    if (by !== LEAD && by !== "user") throw new TeamError("Only main or the user can remove teammates.");
    if (name === LEAD) throw new TeamError("main cannot be removed.");
    const slot = this.slots.get(name);
    if (!slot) throw new TeamError(`No agent named "${name}".`);
    if (slot.removed) return;
    slot.inputs.length = 0;
    slot.queued.length = 0;
    this.approvals.cancelAgent(name, "agent stopped");
    this.approvals.forgetAgent(name);
    // The agent's final "stopped" info and notice come through during dispose; everything after is dropped.
    slot.handle.dispose();
    this.addNotice(slot, by === LEAD ? "Stopped by main." : "Removed from the team.");
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
      mode: this.currentMode,
      contextWindow: s.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
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
    const pendingPlan = agent === LEAD ? this.approvals.pending().find((r) => r.kind === "plan") : undefined;
    if (pendingPlan) {
      // The message answers the plan: "keep planning" with this text as feedback.
      this.showItem(slot, { kind: "user", id: `qmsg-${this.mailSeq++}`, text });
      this.planDecision(pendingPlan.id, false, undefined, text);
      return;
    }
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
    // Plans are answered with planDecision, never through the tool-approval path.
    if (this.approvals.pending().some((r) => r.id === id && r.kind === "plan")) return;
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

  // ---- modes, authorization, plans ----

  get mode(): Mode {
    return this.currentMode;
  }

  /** Switch the team-wide mode: updates config, marks every live agent's chat, and queues a system note for each. */
  setMode(mode: Mode, by = "user"): void {
    if (this.disposed || !(["plan", "normal", "auto", "ultra"] as string[]).includes(mode) || mode === this.currentMode) return;
    // A pending plan is answered "not approved" by any mode change.
    for (const id of [...this.plans.keys()]) this.approvals.resolve(id, "reject", `the mode was changed to ${mode}`);
    this.currentMode = mode;
    this.approvals.forgetAll();
    if (mode === "plan") {
      for (const r of this.approvals.pending()) if (r.kind === "tool") this.approvals.resolve(r.id, "reject", PLAN_REFUSAL);
    }
    for (const [name, slot] of this.slots) {
      if (slot.removed) continue;
      this.showItem(slot, { kind: "mode", id: `mode-${this.mailSeq++}`, mode, by });
      this.notes.set(name, [MODE_NOTES[mode]]); // only the final mode matters
    }
    this.refreshConfig();
  }

  drainSystemNotes(agent: string): string[] {
    const list = this.notes.get(agent) ?? [];
    this.notes.delete(agent);
    return list;
  }

  async authorize(
    req: { id: string; agent: string; tool: string; input: unknown; absPath?: string },
    signal: AbortSignal,
  ): Promise<Authorization> {
    if (signal.aborted || this.disposed) return { approved: false, reason: "stopped by user" };
    const mode = this.currentMode;
    const mutating = MUTATING_TOOLS.has(req.tool);
    const isEdit = req.tool === "edit_file" || req.tool === "write_file";
    if (isEdit) this.notePackageJson(req);
    // Credential files are never read silently, in any mode.
    if (!mutating && this.readsSecret(req)) return this.ask(req, signal, "reads a secrets file");
    if (mode === "plan" && mutating) {
      return {
        approved: false,
        blockedByMode: "plan",
        reason: PLAN_REFUSAL,
      };
    }
    if (mode === "ultra") {
      // No classifier: only the tiny backstop (catastrophic actions and secrets) can ask.
      if (!mutating) return { approved: true, autoApproved: "read in Ultra mode" };
      if (isEdit) {
        const target = this.editTarget(req);
        if (!target || !isInsideRoot(target, this.root)) return this.autoAsk(req, signal, "edit target is outside the workspace", "rule");
        if (isSecretPath(target, this.root)) return this.autoAsk(req, signal, "edit touches a secrets file", "rule");
        return this.autoOk(req, "edit in Ultra mode", "rule");
      }
      const u = ultraBackstop(this.commandOf(req.input), this.root, { written: this.written });
      if (u.verdict === "ask") return this.autoAsk(req, signal, u.rule, "rule");
      return this.autoOk(req, "no backstop rule hit", "rule");
    }
    if (mode === "auto") {
      if (!mutating) return { approved: true, autoApproved: "read in Auto mode" };
      if (isEdit) {
        const target = this.editTarget(req);
        const v = target ? checkEdit(target, this.root) : ({ verdict: "ask", rule: "path unknown" } as const);
        if (v.verdict === "allow") {
          const risk = target ? this.pkgRisk.get(normalizePath(target)) : undefined;
          if (risk) return this.autoAsk(req, signal, `package.json ${risk}`, "rule");
          return this.autoOk(req, "edit inside the workspace", "rule");
        }
        return this.autoAsk(req, signal, v.rule, "rule");
      }
      const command = this.commandOf(req.input);
      const hard = checkCommand(command, this.root, { written: this.written, scriptBody: (n, dir) => this.scriptBody(n, dir), freshFile: (p) => this.isFresh(p), packageJsonChanged: this.pkgChanged });
      if (hard.verdict === "ask") return this.autoAsk(req, signal, hard.rule, "rule");
      if (hard.verdict === "allow") return this.autoOk(req, hard.rule, "rule");
      const classify = this.opts.settings().autoSafetyCheck === false ? undefined : this.opts.classify;
      if (!classify) return this.autoAsk(req, signal, "no safety check is available for commands", "rule");
      let verdict: Awaited<ReturnType<CommandClassifier>>;
      try {
        verdict = await classify(
          { command, cwd: this.root, root: this.root, agent: req.agent, ...(hard.scriptBody !== undefined ? { scriptBody: hard.scriptBody } : {}) },
          signal,
        );
      } catch (e) {
        verdict = { verdict: "ask", reason: `safety check failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (this.disposed) return { approved: false, reason: "team was closed" };
      if (verdict.usage) this.recordUsage(req.agent, verdict.usage);
      if (signal.aborted) return { approved: false, reason: "stopped by user" };
      // The user may have switched modes while the check ran; decide again under the new mode.
      if (this.currentMode !== "auto") return this.authorize(req, signal);
      if (verdict.verdict === "allow") return this.autoOk(req, verdict.reason, "check");
      return this.autoAsk(req, signal, verdict.reason, "check");
    }
    return this.ask(req, signal, undefined);
  }

  private readsSecret(req: { tool: string; input: unknown; absPath?: string }): boolean {
    const input = (req.input ?? {}) as { path?: unknown; glob?: unknown };
    if (req.absPath && isSecretPath(req.absPath, this.root)) return true;
    if (typeof input.path === "string" && isSecretPath(path.resolve(this.root, input.path), this.root)) return true;
    return typeof input.glob === "string" && globNamesSecrets(input.glob);
  }

  /** For an edit to a package.json, work out whether the change touches scripts, hooks, bin or config. */
  private notePackageJson(req: { tool: string; input: unknown; absPath?: string }): void {
    const target = this.editTarget(req);
    if (!target || path.basename(target).toLowerCase() !== "package.json") return;
    const key = normalizePath(target);
    const input = (req.input ?? {}) as { old_str?: unknown; new_str?: unknown; contents?: unknown };
    let before: string | undefined;
    try {
      before = fs.readFileSync(target, "utf8");
    } catch {
      before = undefined;
    }
    let after: string | undefined;
    if (req.tool === "write_file" && typeof input.contents === "string") {
      after = input.contents;
    } else if (req.tool === "edit_file" && before !== undefined && typeof input.old_str === "string" && typeof input.new_str === "string") {
      const first = before.indexOf(input.old_str);
      after = first >= 0 && before.indexOf(input.old_str, first + 1) < 0 ? before.slice(0, first) + input.new_str + before.slice(first + input.old_str.length) : undefined;
    }
    this.pkgRisk.set(key, after === undefined ? "edit could not be analysed" : packageJsonRisk(before, after));
  }

  private editTarget(req: { input: unknown; absPath?: string }): string | undefined {
    if (req.absPath) return req.absPath;
    const p = this.pathOf(req.input);
    return p ? path.resolve(this.root, p) : undefined;
  }

  private scriptBody(name: string, dir?: string): string | undefined {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir ?? this.root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
      const body = pkg.scripts?.[name];
      return typeof body === "string" ? body : undefined;
    } catch {
      return undefined;
    }
  }

  private isFresh(absPath: string): boolean {
    try {
      const st = fs.statSync(absPath);
      return st.isFile() && (st.mtimeMs >= this.startedAt - 1000 || st.birthtimeMs >= this.startedAt - 1000);
    } catch {
      return false;
    }
  }

  /** Called after a successful edit/write so the written-file rule can apply to later commands. */
  recordWrite(_agent: string, absPath: string): void {
    const key = normalizePath(absPath);
    if (path.basename(absPath).toLowerCase() === "package.json") this.pkgChanged = true;
    if (this.pkgRisk.has(key)) {
      const risk = this.pkgRisk.get(key);
      this.pkgRisk.delete(key);
      if (risk === undefined) return; // a harmless package.json edit (dependencies, version ...) does not taint npm scripts
    }
    this.written.add(key);
  }

  /**
   * `callId` is the tool_use id: a call that Auto mode approved must not run once the team has left Auto
   * (the user switched mode while a batch was running); loop reports the reason and the model can retry.
   */
  canRun(tool: string, _agent: string, callId?: string): { ok: true } | { ok: false; reason: string; blockedByMode: Mode } {
    if (this.currentMode === "plan" && MUTATING_TOOLS.has(tool)) return { ok: false, reason: PLAN_REFUSAL, blockedByMode: "plan" };
    const approvedIn = callId !== undefined ? this.autoApprovedIds.get(callId) : undefined;
    if (callId !== undefined && approvedIn !== undefined) {
      this.autoApprovedIds.delete(callId);
      if (STRICTNESS[this.currentMode] > STRICTNESS[approvedIn]) {
        return {
          ok: false,
          reason: `The mode changed from ${approvedIn} to ${this.currentMode} after this call was approved without asking. Ask again; it now needs the user's approval.`,
          blockedByMode: this.currentMode,
        };
      }
    }
    return { ok: true };
  }

  private pathOf(input: unknown): string | undefined {
    const p = (input as { path?: unknown } | undefined)?.path;
    return typeof p === "string" ? p : undefined;
  }

  private commandOf(input: unknown): string {
    const c = (input as { command?: unknown } | undefined)?.command;
    return typeof c === "string" ? c : "";
  }

  /** One log line per Auto decision, always from here: `[auto] allow (rule: x) agent: cmd`. */
  private logAuto(
    outcome: "allow" | "ask",
    source: "rule" | "check",
    req: { agent: string; tool: string; input: unknown },
    why: string,
  ): void {
    const clip = (x: string) => x.replace(/\s+/g, " ").trim().slice(0, 200);
    const isCmd = req.tool === "run_command";
    const subject = isCmd ? clip(this.commandOf(req.input)) : `edit ${clip(this.pathOf(req.input) ?? req.tool)}`;
    this.opts.log?.(`[${this.currentMode === "ultra" ? "ultra" : "auto"}] ${outcome} (${source}: ${clip(why)}) ${req.agent}: ${subject}`);
  }

  private autoAsk(
    req: { id: string; agent: string; tool: string; input: unknown; absPath?: string },
    signal: AbortSignal,
    reason: string,
    source: "rule" | "check",
  ): Promise<Authorization> {
    this.logAuto("ask", source, req, reason);
    return this.ask(req, signal, reason);
  }

  private autoOk(req: { id?: string; agent: string; tool: string; input: unknown }, why: string, source: "rule" | "check"): Authorization {
    if (req.id) this.autoApprovedIds.set(req.id, this.currentMode);
    if (req.tool === "run_command") for (const p of writeTargets(this.commandOf(req.input), this.root)) this.written.add(p);
    this.logAuto("allow", source, req, why);
    // Classifier text is model-generated: show it as plain text, clipped.
    return { approved: true, autoApproved: why.replace(/\s+/g, " ").slice(0, 200) };
  }

  /** Put a tool call in the shared approval queue. In Auto mode `askReason` explains why the user is asked. */
  private async ask(
    req: { id: string; agent: string; tool: string; input: unknown; absPath?: string },
    signal: AbortSignal,
    askReason: string | undefined,
  ): Promise<Authorization> {
    if (askReason) askReason = askReason.replace(/\s+/g, " ").slice(0, 200);
    const isEdit = req.tool === "edit_file" || req.tool === "write_file";
    const target = isEdit ? this.editTarget(req) : undefined;
    const sensitive =
      target !== undefined && (isSensitivePath(target, this.root) || this.pkgRisk.get(normalizePath(target)) !== undefined);
    const r = await this.approvals.request(
      {
        id: req.id,
        agent: req.agent,
        kind: "tool",
        tool: req.tool,
        input: req.input,
        // "Approve all edits" only covers ordinary edits, never ones a safety rule flagged.
        coverable: isEdit && askReason === undefined && !sensitive,
        ...(askReason ? { askReason } : {}),
      },
      signal,
    );
    if (r.approved && req.tool === "run_command") {
      for (const p of writeTargets(this.commandOf(req.input), this.root)) this.written.add(p);
    }
    return r.approved ? { approved: true } : { approved: false, reason: r.reason };
  }

  async presentPlan(
    req: { id: string; agent: string; title: string; summary: string; steps: PlanStep[] },
    signal: AbortSignal,
  ): Promise<{ approved: boolean; mode?: "normal" | "auto"; feedback?: string }> {
    const slot = this.slots.get(req.agent);
    if (!slot || slot.removed || req.agent !== LEAD) throw new TeamError("Only main can present a plan.");
    if (this.currentMode !== "plan") {
      throw new TeamError(`present_plan is only available in Plan mode (the team is in ${this.currentMode} mode).`);
    }
    if (this.plans.size > 0) throw new TeamError("A plan is already waiting for the user's decision.");
    const item: ChatItem = { kind: "plan", id: req.id, title: req.title, summary: req.summary, steps: req.steps, status: "awaiting" };
    this.showItem(slot, item);
    this.plans.set(req.id, {});
    const r = await this.approvals.request(
      {
        id: req.id,
        agent: req.agent,
        kind: "plan",
        tool: "present_plan",
        input: { title: req.title, summary: req.summary, steps: req.steps },
        coverable: false,
      },
      signal,
    );
    const decision = this.plans.get(req.id) ?? {};
    this.plans.delete(req.id);
    if (r.approved) {
      const mode = decision.mode ?? "normal";
      this.replaceItem(slot, { ...item, status: "approved", approvedMode: mode } as ChatItem);
      this.setMode(mode, "plan approval");
      return { approved: true, mode };
    }
    const feedback = decision.feedback ?? r.reason ?? "";
    this.replaceItem(slot, { ...item, status: "rejected", feedback } as ChatItem);
    return { approved: false, feedback };
  }

  /** The user's answer to a plan: approve (choosing the mode to switch to) or reject with feedback. */
  planDecision(id: string, approve: boolean, mode?: "normal" | "auto", feedback?: string): void {
    const entry = this.plans.get(id);
    if (!entry || !this.approvals.pending().some((r) => r.id === id && r.kind === "plan")) return;
    entry.mode = mode === "auto" ? "auto" : "normal";
    entry.feedback = feedback;
    this.approvals.resolve(id, approve ? "approve" : "reject", feedback);
  }

  private replaceItem(slot: Slot, item: ChatItem): void {
    const t = slot.handle.transcript;
    const i = t.findIndex((x) => x.id === item.id);
    if (i >= 0) t[i] = item;
    else t.push(item);
    this.emit({ type: "item", agent: slot.handle.name, item });
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
    // An agent created in Plan or Auto learns the mode up front instead of from a refused call.
    if (this.currentMode !== "normal") this.notes.set(name, [MODE_NOTES[this.currentMode]]);
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
