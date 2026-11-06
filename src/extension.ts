import * as vscode from "vscode";
import { SECRET_KEY } from "./agent/client";
import { configureAgentRuntime } from "./agent/loop";
import { ChatPanel } from "./ChatPanel";
import { MODES, type Mode } from "./shared/protocol";

const MODE_LABEL: Record<Mode, string> = { plan: "Plan", normal: "Normal", auto: "Auto" };

function defaultMode(): Mode {
  const v = vscode.workspace.getConfiguration("nextAgent").get<string>("defaultMode", "normal");
  return v === "plan" ? "plan" : "normal"; // Auto is never a default
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("NextAgent");
  void migrateLegacySettings(output);
  configureAgentRuntime({ secrets: context.secrets, output });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  let mode: Mode = defaultMode();
  let pending = 0;
  const renderStatus = () => {
    status.backgroundColor = mode === "auto" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    status.text = `${pending > 0 ? "$(bell)" : "$(hubot)"} NextAgent · ${MODE_LABEL[mode]}${pending > 0 ? ` (${pending})` : ""}`;
  };
  renderStatus();
  status.tooltip = "Open NextAgent";
  status.command = "nextAgent.open";
  status.show();

  context.subscriptions.push(
    output,
    status,
    ChatPanel.onPendingApprovals((n) => {
      pending = n;
      renderStatus();
    }),
    ChatPanel.onModeChange((m) => {
      mode = m;
      renderStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nextAgent.defaultMode") && !ChatPanel.active) {
        mode = defaultMode();
        renderStatus();
      }
    }),
    vscode.commands.registerCommand("nextAgent.setMode", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Plan", description: "Read-only; main presents a plan for approval", mode: "plan" as Mode },
          { label: "Normal", description: "Edits and commands need your approval", mode: "normal" as Mode },
          { label: "Auto", description: "Edits run freely; risky commands still ask", mode: "auto" as Mode },
        ],
        { title: "NextAgent mode" },
      );
      if (!pick) return;
      // The mode belongs to the team, so open the panel (and its team) first.
      const panel = await ChatPanel.open(context, output);
      panel?.setTeamMode(pick.mode);
    }),
    vscode.commands.registerCommand("nextAgent.open", async () => {
      await ChatPanel.open(context, output);
    }),
    vscode.commands.registerCommand("nextAgent.newTeam", async () => {
      const panel = await ChatPanel.open(context, output);
      await panel?.newTeam();
    }),
    vscode.commands.registerCommand("nextAgent.stopAll", () => ChatPanel.active?.stopAll()),
    vscode.commands.registerCommand("nextAgent.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Anthropic API key",
        prompt: "Stored in VS Code's secret storage.",
        password: true,
        ignoreFocusOut: true,
      });
      if (!key?.trim()) return;
      await context.secrets.store(SECRET_KEY, key.trim());
      await ChatPanel.active?.postConfig();
      void vscode.window.showInformationMessage("NextAgent: API key saved.");
    }),
    vscode.commands.registerCommand("nextAgent.clearApiKey", async () => {
      await context.secrets.delete(SECRET_KEY);
      await ChatPanel.active?.postConfig();
      void vscode.window.showInformationMessage("NextAgent: API key cleared.");
    }),
  );
}

export function deactivate(): void {
  ChatPanel.active?.stopAll();
}

const LEGACY_SETTINGS = [
  "model", "effort", "maxTokens", "autoApproveReads", "commandTimeoutSec", "refusalFallback",
  "teammateModel", "maxTeammates", "maxAutoTurns", "maxTurnIterations", "maxTeamOutputTokens",
];

/** Copy user-level agentHarness.* values to nextAgent.* once (the extension was renamed). */
async function migrateLegacySettings(output: vscode.OutputChannel): Promise<void> {
  const old = vscode.workspace.getConfiguration("agentHarness");
  const cur = vscode.workspace.getConfiguration("nextAgent");
  for (const key of LEGACY_SETTINGS) {
    try {
      const prev = old.inspect(key)?.globalValue;
      if (prev === undefined || cur.inspect(key)?.globalValue !== undefined) continue;
      await cur.update(key, prev, vscode.ConfigurationTarget.Global);
      output.appendLine(`[migrate] agentHarness.${key} -> nextAgent.${key}`);
    } catch {
      // ignore: the setting may not be writable
    }
  }
}
