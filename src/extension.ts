import * as vscode from "vscode";
import { SECRET_KEY } from "./agent/client";
import { ChatViewProvider } from "./ChatViewProvider";

let provider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Agent Harness");
  provider = new ChatViewProvider(context, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("agentHarness.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Anthropic API key",
        prompt: "Stored in VS Code's secret storage.",
        password: true,
        ignoreFocusOut: true,
      });
      if (!key?.trim()) return;
      await context.secrets.store(SECRET_KEY, key.trim());
      await provider?.postConfig();
      void vscode.window.showInformationMessage("Agent Harness: API key saved.");
    }),
    vscode.commands.registerCommand("agentHarness.clearApiKey", async () => {
      await context.secrets.delete(SECRET_KEY);
      await provider?.postConfig();
      void vscode.window.showInformationMessage("Agent Harness: API key cleared.");
    }),
    vscode.commands.registerCommand("agentHarness.newChat", () => provider?.newChat()),
    vscode.commands.registerCommand("agentHarness.stop", () => provider?.session.stop()),
  );
}

export function deactivate(): void {
  provider?.session.stop();
}
