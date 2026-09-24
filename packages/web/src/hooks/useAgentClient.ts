import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AgentClient, type ClientSnapshot } from "../state/client";
import type { ClientCommand } from "@mini-agent/server";

function defaultWebSocketUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export interface AgentClientBinding extends ClientSnapshot {
  send(command: ClientCommand): void;
}

export function useAgentClient(url?: string): AgentClientBinding {
  const client = useMemo(
    () => new AgentClient(url ?? defaultWebSocketUrl()),
    [url],
  );

  useEffect(() => {
    client.connect();
    return () => client.dispose();
  }, [client]);

  const snapshot = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getSnapshot(),
  );

  return { ...snapshot, send: (command) => client.send(command) };
}
