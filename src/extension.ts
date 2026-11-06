import * as vscode from "vscode";
import { SECRET_KEY } from "./agent/client";
import { configureAgentRuntime } from "./agent/loop";
import { ChatPanel } from "./ChatPanel";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Agent Harness");
  configureAgentRuntime({ secrets: context.secrets, output });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(hubot) Agent Harness";
  status.tooltip = "Open Agent Harness";
  status.command = "agentHarness.open";
  status.show();

  context.subscriptions.push(
    output,
    status,
    ChatPanel.onPendingApprovals((n) => {
      status.text = n > 0 ? `$(bell) Agent Harness (${n})` : "$(hubot) Agent Harness";
    }),
    vscode.commands.registerCommand("agentHarness.open", async () => {
      await ChatPanel.open(context, output);
    }),
    vscode.commands.registerCommand("agentHarness.newTeam", async () => {
      const panel = await ChatPanel.open(context, output);
      await panel?.newTeam();
    }),
    vscode.commands.registerCommand("agentHarness.stopAll", () => ChatPanel.active?.stopAll()),
    vscode.commands.registerCommand("agentHarness.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Anthropic API key",
        prompt: "Stored in VS Code's secret storage.",
        password: true,
        ignoreFocusOut: true,
      });
      if (!key?.trim()) return;
      await context.secrets.store(SECRET_KEY, key.trim());
      await ChatPanel.active?.postConfig();
      void vscode.window.showInformationMessage("Agent Harness: API key saved.");
    }),
    vscode.commands.registerCommand("agentHarness.clearApiKey", async () => {
      await context.secrets.delete(SECRET_KEY);
      await ChatPanel.active?.postConfig();
      void vscode.window.showInformationMessage("Agent Harness: API key cleared.");
    }),
  );
}

export function deactivate(): void {
  ChatPanel.active?.stopAll();
}
