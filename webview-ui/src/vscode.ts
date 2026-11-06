import type { WebviewMessage } from "@shared/protocol";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  draft?: string;
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

export function loadDraft(): string {
  return readState().draft ?? "";
}

export function saveDraft(draft: string): void {
  try {
    api?.setState({ ...readState(), draft });
  } catch {
    /* ignore */
  }
}
