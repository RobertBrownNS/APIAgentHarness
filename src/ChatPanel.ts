import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { z } from "zod";
import { hasCredentials } from "./agent/client";
import { listLocalModels, localKey, localServerUrl } from "./agent/local";
import type { Effort, HostMessage, WebviewMessage } from "./shared/protocol";
import { EFFORTS, isLocalModel, LOCAL_PREFIX, MODES } from "./shared/protocol";
import { createCommandClassifier } from "./agent/classifier";
import type { Mode } from "./shared/protocol";
import { AgentSession } from "./agent/loop";
import { Team, type TeamSettings } from "./team/team";

const effortSchema = z.enum(EFFORTS as [Effort, ...Effort[]]);
const nameSchema = z.string().min(1).max(64);
const modeSchema = z.enum(MODES as [Mode, ...Mode[]]);
const taskStatusSchema = z.enum(["pending", "in_progress", "completed"]);

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("send"), agent: nameSchema, text: z.string().trim().min(1).max(100_000) }),
  z.object({ type: z.literal("stop"), agent: nameSchema.optional() }),
  z.object({ type: z.literal("resume"), agent: nameSchema }),
  z.object({ type: z.literal("newTeam") }),
  z.object({
    type: z.literal("approval"),
    id: z.string().min(1).max(200),
    decision: z.enum(["approve", "approveAll", "reject"]),
    reason: z.string().max(10_000).optional(),
  }),
  z.object({ type: z.literal("setMode"), mode: modeSchema }),
  z.object({
    type: z.literal("planDecision"),
    id: z.string().min(1).max(200),
    approve: z.boolean(),
    mode: z.enum(["normal", "auto"]).optional(),
    feedback: z.string().max(10_000).optional(),
  }),
  z.object({
    type: z.literal("addTeammate"),
    name: nameSchema,
    role: z.string().max(500),
    model: z.string().max(200).optional(),
    effort: effortSchema.optional(),
  }),
  z.object({ type: z.literal("removeTeammate"), name: nameSchema }),
  z.object({ type: z.literal("setAgentModel"), agent: nameSchema, model: z.string().min(1).max(200) }),
  z.object({ type: z.literal("setAgentEffort"), agent: nameSchema, effort: effortSchema }),
  z.object({
    type: z.literal("createTask"),
    subject: z.string().min(1).max(500),
    description: z.string().max(50_000),
    blockedBy: z.array(z.string().max(20)).max(100).optional(),
  }),
  z.object({
    type: z.literal("updateTask"),
    id: z.string().min(1).max(20),
    status: taskStatusSchema.optional(),
    owner: nameSchema.nullable().optional(),
  }),
  z.object({ type: z.literal("setApiKey") }),
]);

/** The single editor tab hosting the agent team chat. Closing it disposes the team. */
export class ChatPanel {
  static readonly viewType = "nextAgent.panel";
  private static current: ChatPanel | undefined;

  private team: Team;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private pending = 0;
  private readonly root: string;
  private teamSeq = 0;
  private mode: Mode = "normal";
  private static readonly pendingEmitter = new vscode.EventEmitter<number>();
  private static readonly modeEmitter = new vscode.EventEmitter<Mode>();
  /** Fires whenever the team's mode changes (and when the panel opens or closes, with the default mode). */
  static readonly onModeChange = ChatPanel.modeEmitter.event;
  /** Fires with the number of approvals waiting while the tab is not focused (0 otherwise). */
  static readonly onPendingApprovals = ChatPanel.pendingEmitter.event;

  /** Show the panel, creating it (and a fresh team) if needed. */
  static async open(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<ChatPanel | undefined> {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(undefined, false);
      return ChatPanel.current;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showErrorMessage("NextAgent: open a folder first.");
      return undefined;
    }
    const creds = await hasCredentials(context.secrets);
    if (ChatPanel.current) return ChatPanel.current; // opened concurrently
    const distUri = vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist");
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      "NextAgent",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distUri] },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    ChatPanel.current = new ChatPanel(panel, context, output, root, creds, distUri);
    return ChatPanel.current;
  }

  /** The open panel, if any. */
  static get active(): ChatPanel | undefined {
    return ChatPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    root: string,
    private creds: boolean,
    distUri: vscode.Uri,
  ) {
    this.root = root;
    this.team = this.createTeam();
    panel.webview.html = this.html(panel.webview, distUri);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(() => this.refreshAlert()),
      panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nextAgent")) void this.postConfig();
      }),
    );
  }

  private post(m: HostMessage): void {
    if (this.disposed) return;
    if (m.type === "approvals" || m.type === "snapshot") this.updateAlert(m.approvals.length);
    if (m.type === "config" || m.type === "snapshot") this.setMode(m.config.mode);
    try {
      void Promise.resolve(this.panel.webview.postMessage(m)).catch(() => undefined);
    } catch {
      // Webview already gone; late events from unwinding agents are dropped.
    }
  }

  /** Flag pending approvals in the tab title and status bar while the tab is not focused. */
  private updateAlert(count: number): void {
    this.pending = count;
    this.refreshAlert();
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    ChatPanel.modeEmitter.fire(mode);
  }

  get currentMode(): Mode {
    return this.mode;
  }

  setTeamMode(mode: Mode): void {
    this.team.setMode(mode, "user");
  }

  private refreshAlert(): void {
    if (this.disposed) return;
    const show = this.pending > 0 && !this.panel.active;
    this.panel.title = show ? `NextAgent (${this.pending})` : "NextAgent";
    ChatPanel.pendingEmitter.fire(show ? this.pending : 0);
  }

  private createTeam(): Team {
    const seq = ++this.teamSeq;
    return new Team({
      root: this.root,
      settings: () => this.settings(),
      // Drop events from a team that newTeam() has replaced.
      emit: (m) => {
        if (seq === this.teamSeq) this.post(m);
      },
      createAgent: (o) => new AgentSession(o),
      classify: createCommandClassifier(
        this.context.secrets,
        () => vscode.workspace.getConfiguration("nextAgent").get<string>("autoSafetyModel", "claude-haiku-5-5"),
        // Without a Claude key, the safety check asks a local model: the configured one, else the first loaded one.
        () => {
          const chosen = vscode.workspace.getConfiguration("nextAgent").get<string>("local.safetyModel", "").trim();
          return chosen ? (isLocalModel(chosen) ? chosen : `${LOCAL_PREFIX}${chosen}`) : this.localModels[0];
        },
      ),
      log: (line) => this.output.appendLine(line),
    });
  }

  private settings(): TeamSettings {
    const cfg = vscode.workspace.getConfiguration("nextAgent");
    return {
      model: cfg.get<string>("model", "claude-opus-5-5"),
      effort: cfg.get<Effort>("effort", "high"),
      teammateModel: cfg.get<string>("teammateModel", ""),
      maxTeammates: cfg.get<number>("maxTeammates", 0),
      maxAutoTurns: cfg.get<number>("maxAutoTurns", 0),
      maxTurnIterations: cfg.get<number>("maxTurnIterations", 0),
      maxTeamOutputTokens: cfg.get<number>("maxTeamOutputTokens", 0),
      hasCredentials: this.creds,
      localModels: this.localModels,
      localServer: localServerUrl(),
      hasLocalKey: this.hasLocalKey,
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
      autoSafetyCheck: cfg.get<boolean>("autoSafetyCheck", true),
      contextWindow: 1_000_000,
      defaultMode: cfg.get<Mode>("defaultMode", "normal") === "plan" ? "plan" : "normal",
    };
  }

  /** Unsloth Desktop models ("local:<id>") and whether its key is saved; refreshed with the config. */
  private localModels: string[] = [];
  private hasLocalKey = false;

  private async refreshLocal(): Promise<void> {
    this.hasLocalKey = Boolean(await localKey(this.context.secrets));
    this.localModels = this.hasLocalKey ? await listLocalModels(this.context.secrets) : [];
  }

  /** Re-check credentials and local models, then push the config (after settings or API key changes). */
  async postConfig(): Promise<void> {
    this.creds = await hasCredentials(this.context.secrets);
    await this.refreshLocal();
    if (this.disposed) return;
    this.team.refreshConfig();
  }

  private async postSnapshot(): Promise<void> {
    this.creds = await hasCredentials(this.context.secrets);
    if (this.disposed) return;
    this.post(this.team.snapshot());
    // The local model list can take a moment (Unsloth may be starting); push it when it arrives.
    void this.refreshLocal().then(() => {
      if (!this.disposed) this.team.refreshConfig();
    });
  }

  private confirmingNewTeam = false;

  async newTeam(): Promise<void> {
    if (this.confirmingNewTeam) return;
    this.confirmingNewTeam = true;
    try {
      await this.newTeamConfirmed();
    } finally {
      this.confirmingNewTeam = false;
    }
  }

  private async newTeamConfirmed(): Promise<void> {
    if (this.isBusy()) {
      const pick = await vscode.window.showWarningMessage(
        "Agents are still working. Start a new team and stop them all?",
        { modal: true },
        "New team",
      );
      if (pick !== "New team") return;
    }
    const old = this.team;
    this.team = this.createTeam(); // epoch bump drops the old team's late events
    try {
      old.dispose();
    } catch {
      // keep going
    }
    this.pending = 0;
    this.refreshAlert();
    await this.postSnapshot();
  }

  private isBusy(): boolean {
    const snap = this.team.snapshot();
    return snap.type === "snapshot" && snap.agents.some((a) => a.status === "running" || a.status === "awaiting");
  }

  stopAll(): void {
    this.team.stop();
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) return;
    const m = parsed.data as WebviewMessage;
    try {
      switch (m.type) {
        case "ready":
          await this.postSnapshot();
          break;
        case "send":
          this.team.send(m.agent, m.text);
          break;
        case "stop":
          this.team.stop(m.agent);
          break;
        case "resume":
          this.team.resume(m.agent);
          break;
        case "newTeam":
          await this.newTeam();
          break;
        case "approval":
          this.team.approval(m.id, m.decision, m.reason);
          break;
        case "setMode":
          this.team.setMode(m.mode, "user");
          break;
        case "planDecision":
          this.team.planDecision(m.id, m.approve, m.mode === "ultra" ? undefined : m.mode, m.feedback);
          break;
        case "addTeammate":
          this.team.addTeammate({ name: m.name, role: m.role, model: m.model, effort: m.effort });
          break;
        case "removeTeammate":
          this.team.removeTeammateByUser(m.name);
          break;
        case "setAgentModel":
          this.team.setAgentModel(m.agent, m.model);
          break;
        case "setAgentEffort":
          this.team.setAgentEffort(m.agent, m.effort);
          break;
        case "createTask":
          this.team.createTask({ subject: m.subject, description: m.description, blockedBy: m.blockedBy });
          break;
        case "updateTask":
          this.team.updateTask(m.id, { status: m.status, owner: m.owner });
          break;
        case "setApiKey":
          await vscode.commands.executeCommand("nextAgent.setApiKey");
          break;
      }
    } catch (e) {
      // Team/Task errors carry messages meant for the user (bad name, size limit, blocked task, ...).
      void vscode.window.showErrorMessage(`NextAgent: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (ChatPanel.current === this) ChatPanel.current = undefined;
    ChatPanel.pendingEmitter.fire(0);
    ChatPanel.modeEmitter.fire(vscode.workspace.getConfiguration("nextAgent").get<string>("defaultMode", "normal") === "plan" ? "plan" : "normal");
    try {
      this.team.dispose();
    } catch {
      // keep tearing down
    }
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }

  private html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const script = vscode.Uri.joinPath(distUri, "assets", "index.js");
    const style = vscode.Uri.joinPath(distUri, "assets", "index.css");
    if (!fs.existsSync(script.fsPath)) {
      return `<!doctype html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px">
<p>The chat UI has not been built yet. Run <code>npm run build</code> in the extension folder, then reload the window.</p></body></html>`;
    }
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${webview.asWebviewUri(style)}">
<title>NextAgent</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
  }
}
