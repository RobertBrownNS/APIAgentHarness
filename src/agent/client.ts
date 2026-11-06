import Anthropic from "@anthropic-ai/sdk";
import type * as vscode from "vscode";

export const SECRET_KEY = "nextAgent.apiKey";

/**
 * Build a client from the key saved in VS Code's secret storage. With no saved key,
 * fall back to the SDK's own lookup (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
 * `ant auth login` profile). Returns undefined when no credentials are found.
 */
export async function createClient(secrets: vscode.SecretStorage): Promise<Anthropic | undefined> {
  const apiKey = (await secrets.get(SECRET_KEY))?.trim();
  try {
    return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  } catch {
    return undefined;
  }
}

export async function hasCredentials(secrets: vscode.SecretStorage): Promise<boolean> {
  // An `ant auth login` profile can also work, so only a saved key or env var is a sure yes; the UI
  // should not block sending on false. The first request decides.
  if (await secrets.get(SECRET_KEY)) return true;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
