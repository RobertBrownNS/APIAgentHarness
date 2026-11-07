import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";
import { LOCAL_PREFIX } from "../shared/protocol";

/** Unsloth Desktop's API key (sk-unsloth-…), created in Unsloth under Settings → API. */
export const LOCAL_SECRET_KEY = "nextAgent.localApiKey";
export const DEFAULT_LOCAL_URL = "http://localhost:8888";

/**
 * Base URL for the Anthropic SDK. Unsloth serves /v1/messages, and the SDK adds /v1 itself, so a trailing /v1
 * (copied from OpenAI-style setups) is removed.
 */
export function localServerUrl(): string {
  const raw = vscode.workspace.getConfiguration("nextAgent").get<string>("local.baseUrl", DEFAULT_LOCAL_URL) || DEFAULT_LOCAL_URL;
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export async function localKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return (await secrets.get(LOCAL_SECRET_KEY))?.trim() || undefined;
}

/** A client for Unsloth Desktop. Unsloth expects `Authorization: Bearer sk-unsloth-…`, which is what authToken sends. */
export async function createLocalClient(secrets: vscode.SecretStorage): Promise<Anthropic | undefined> {
  const key = await localKey(secrets);
  if (!key) return undefined;
  try {
    return new Anthropic({ baseURL: localServerUrl(), apiKey: null, authToken: key });
  } catch {
    return undefined;
  }
}

/** Models Unsloth Desktop reports, as "local:<id>", loaded ones first. Empty if it isn't running or the key is wrong. */
export async function listLocalModels(secrets: vscode.SecretStorage): Promise<string[]> {
  const key = await localKey(secrets);
  if (!key) return [];
  try {
    const res = await fetch(`${localServerUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: unknown; loaded?: unknown }[] };
    const models = (body.data ?? []).filter((m): m is { id: string; loaded?: unknown } => typeof m.id === "string" && m.id.length > 0);
    models.sort((a, b) => Number(Boolean(b.loaded)) - Number(Boolean(a.loaded)));
    return models.map((m) => `${LOCAL_PREFIX}${m.id}`);
  } catch {
    return [];
  }
}
