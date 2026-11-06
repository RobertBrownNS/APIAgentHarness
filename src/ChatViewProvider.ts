import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { hasCredentials } from "./agent/client";
import { AgentSession } from "./agent/loop";
import type { Effort, HostMessage, SessionConfig, WebviewMessage } from "./shared/protocol";
import { EFFORTS } from "./shared/protocol";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "agentHarness.chat";

  private view?: vscode.WebviewView;
  readonly session: AgentSession;

  constructor(
    private readonly context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
  ) {
    this.session = new AgentSession(context, output, (m) => this.post(m));
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("agentHarness")) void this.postConfig();
      }),
    );
  }

  private post(m: HostMessage): void {
    if (!this.view) return;
    void this.view.webview.postMessage(m);
  }

  async getConfig(): Promise<SessionConfig> {
    const cfg = vscode.workspace.getConfiguration("agentHarness");
    return {
      model: cfg.get<string>("model", "claude-opus-5-5"),
      effort: cfg.get<Effort>("effort", "high"),
      hasCredentials: await hasCredentials(this.context.secrets),
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
    };
  }

  async postConfig(): Promise<void> {
    this.post({ type: "config", config: await this.getConfig() });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    view.webview.html = this.html(view.webview, distUri);
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m));
  }

  /** Clear the chat and tell the webview, whichever path (button, title bar, command) triggered it. */
  async newChat(): Promise<void> {
    this.session.reset();
    this.post({ type: "snapshot", items: [], busy: false, config: await this.getConfig() });
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "ready":
        this.post({
          type: "snapshot",
          items: this.session.transcript,
          busy: this.session.busy,
          config: await this.getConfig(),
        });
        break;
      case "send":
        if (typeof m.text === "string") await this.session.send(m.text);
        break;
      case "stop":
        this.session.stop();
        break;
      case "newChat":
        await this.newChat();
        break;
      case "approval":
        if (
          typeof m.id === "string" &&
          (m.decision === "approve" || m.decision === "approveAll" || m.decision === "reject")
        ) {
          this.session.approvals.resolve(m.id, m.decision, typeof m.reason === "string" ? m.reason : undefined);
        }
        break;
      case "setModel":
        if (typeof m.model === "string" && m.model) {
          await vscode.workspace
            .getConfiguration("agentHarness")
            .update("model", m.model, vscode.ConfigurationTarget.Global);
        }
        await this.postConfig();
        break;
      case "setEffort":
        if (EFFORTS.includes(m.effort)) {
          await vscode.workspace
            .getConfiguration("agentHarness")
            .update("effort", m.effort, vscode.ConfigurationTarget.Global);
        }
        await this.postConfig();
        break;
      case "setApiKey":
        await vscode.commands.executeCommand("agentHarness.setApiKey");
        break;
    }
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
<title>Agent Harness</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
  }
}
