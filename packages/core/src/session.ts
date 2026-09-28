import type {
  AgentMessage,
  SystemMessage,
} from "./types.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type QueueName = "steering" | "followUp";

export interface PendingEffect {
  toolCallId: string;
  toolName: string;
  arguments: JsonValue;
  replay: "safe" | "never";
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionOperation =
  | { type: "message"; message: AgentMessage }
  | { type: "queue_enqueued"; queue: QueueName; message: AgentMessage }
  | { type: "queue_dequeued"; queue: QueueName; messageId: string }
  | { type: "effect_started"; effect: PendingEffect }
  | { type: "effect_finished"; toolCallId: string }
  | { type: "effect_cancelled"; toolCallId: string }
  | { type: "reset"; systemMessage: SystemMessage };

export type SessionRecord =
  | { type: "session"; version: 1; metadata: SessionMetadata }
  | {
      type: "commit";
      sequence: number;
      timestamp: string;
      operations: SessionOperation[];
    };

export interface SessionRecoveryWarning {
  kind: "unknown" | "cancelled";
  effect: PendingEffect;
  message: string;
}

export interface SessionLoadDiagnostic {
  kind: "truncated_tail";
  message: string;
}

export interface SessionSnapshot {
  metadata: SessionMetadata;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  pendingEffects: PendingEffect[];
  cancelledEffects: PendingEffect[];
  recoveryWarnings: SessionRecoveryWarning[];
  loadDiagnostics: SessionLoadDiagnostic[];
  lastSequence: number;
}

export interface SessionStore {
  create(metadata: SessionMetadata): Promise<void>;
  load(sessionId: string): Promise<SessionSnapshot>;
  append(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void>;
  list(): Promise<SessionMetadata[]>;
}

export interface QueuedMessageReservation {
  queue: QueueName;
  message: AgentMessage;
}

export interface MessageCommit {
  messages: readonly AgentMessage[];
  dequeued?: readonly QueuedMessageReservation[];
}

export interface SessionCommitter {
  commitMessages(commit: MessageCommit): Promise<void>;
  enqueue(queue: QueueName, message: AgentMessage): Promise<void>;
  startEffect(effect: PendingEffect): Promise<void>;
  finishEffect(toolCallId: string): Promise<void>;
  cancelEffect(toolCallId: string): Promise<void>;
  reset(systemMessage: SystemMessage): Promise<void>;
}

export interface OpenedSession {
  snapshot: SessionSnapshot;
  committer: SessionCommitter;
}
