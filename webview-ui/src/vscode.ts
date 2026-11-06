import type { WebviewMessage } from "@shared/protocol";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  drafts?: Record<string, string>;
}

let api: VsCodeApi | undefined;
try {
  api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
} catch {
  api = undefined;
}

export function post(msg: WebviewMessage): void {
  if (api) api.postMessage(msg);
  else console.log("[webview -> host]", msg);
}

function readState(): PersistedState {
  try {
    return ((api ? api.getState() : undefined) as PersistedState | undefined) ?? {};
  } catch {
    return {};
  }
}

export function loadDraft(agent: string): string {
  return readState().drafts?.[agent] ?? "";
}

export function saveDraft(agent: string, draft: string): void {
  try {
    const s = readState();
    const drafts = { ...s.drafts };
    if (draft) drafts[agent] = draft.slice(0, 20000);
    else delete drafts[agent];
    api?.setState({ ...s, drafts });
  } catch {
    /* ignore */
  }
}
