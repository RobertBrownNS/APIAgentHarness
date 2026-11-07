import Anthropic from "@anthropic-ai/sdk";
import type * as vscode from "vscode";
import { isLocalModel } from "../shared/protocol";
import { createLocalClient, localKey } from "./local";

export const SECRET_KEY = "nextAgent.apiKey";

/**
 * Build a client for `model`: Unsloth Desktop for "local:<id>" models, otherwise Claude. For Claude, use the key saved
 * in VS Code's secret storage, falling back to the SDK's own lookup (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
 * `ant auth login` profile). Returns undefined when no credentials are found.
 */
export async function createClient(secrets: vscode.SecretStorage, model?: string): Promise<Anthropic | undefined> {
  if (model && isLocalModel(model)) return createLocalClient(secrets);
  const apiKey = (await secrets.get(SECRET_KEY))?.trim();
  try {
    return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  } catch {
    return undefined;
  }
}

/** A Claude key (saved or in the environment) is known to exist. An `ant auth login` profile may also work. */
export async function hasClaudeCredentials(secrets: vscode.SecretStorage): Promise<boolean> {
  if (await secrets.get(SECRET_KEY)) return true;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function hasCredentials(secrets: vscode.SecretStorage): Promise<boolean> {
  // The UI should not block sending on false; the first request decides.
  return (await hasClaudeCredentials(secrets)) || Boolean(await localKey(secrets));
}
