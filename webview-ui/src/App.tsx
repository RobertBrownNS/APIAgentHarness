import { useEffect, useReducer } from "react";
import type { ChatItem, HostMessage, SessionConfig } from "@shared/protocol";
import { post } from "@/vscode";
import { Header } from "@/components/Header";
import { MessageList } from "@/components/MessageList";
import { Composer } from "@/components/Composer";

interface State {
  items: ChatItem[];
  busy: boolean;
  config: SessionConfig;
}

const initial: State = {
  items: [],
  busy: false,
  config: { model: "", effort: "medium", hasCredentials: true },
};

function reducer(state: State, msg: HostMessage): State {
  switch (msg.type) {
    case "snapshot":
      return { items: msg.items, busy: msg.busy, config: msg.config };
    case "item": {
      const i = state.items.findIndex((it) => it.id === msg.item.id);
      if (i < 0) return { ...state, items: [...state.items, msg.item] };
      const items = state.items.slice();
      items[i] = msg.item;
      return { ...state, items };
    }
    case "append": {
      const i = state.items.findIndex((it) => it.id === msg.id);
      if (i < 0) return state;
      const it = state.items[i];
      if (it.kind !== "text" && it.kind !== "thinking") return state;
      const items = state.items.slice();
      items[i] = { ...it, text: it.text + msg.text };
      return { ...state, items };
    }
    case "busy":
      return { ...state, busy: msg.busy };
    case "config":
      return { ...state, config: msg.config };
    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostMessage>) => {
      if (e.data && typeof e.data === "object" && "type" in e.data) dispatch(e.data);
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Header config={state.config} />
      <MessageList items={state.items} busy={state.busy} />
      <Composer busy={state.busy} />
    </div>
  );
}
