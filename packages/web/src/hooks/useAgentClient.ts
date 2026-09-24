import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AgentClient, type ClientSnapshot } from "../state/client";
import type { ClientCommand } from "@mini-agent/server";

const defaultUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export interface AgentClientBinding extends ClientSnapshot {
  send(command: ClientCommand): void;
}

export function useAgentClient(
  url: string = defaultUrl,
): AgentClientBinding {
  const client = useMemo(() => new AgentClient(url), [url]);

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
