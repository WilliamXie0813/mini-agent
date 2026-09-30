import type {
  AgentMessage,
  ReplayPolicy,
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

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingEffect {
  toolCallId: string;
  toolName: string;
  arguments: JsonValue;
  replay: ReplayPolicy;
}

export type SessionOperation =
  | { type: "message"; message: AgentMessage }
  | {
      type: "queue_enqueued";
      queue: QueueName;
      message: AgentMessage;
    }
  | {
      type: "queue_dequeued";
      queue: QueueName;
      messageId: string;
    }
  | { type: "effect_started"; effect: PendingEffect }
  | { type: "effect_finished"; toolCallId: string }
  | { type: "effect_cancelled"; toolCallId: string }
  | { type: "reset"; systemMessage: SystemMessage };

export type SessionRecord =
  | {
      type: "session";
      version: 1;
      metadata: SessionMetadata;
    }
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

export interface SessionSnapshot {
  metadata: SessionMetadata;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  pendingEffects: PendingEffect[];
  cancelledEffects: PendingEffect[];
  recoveryWarnings: SessionRecoveryWarning[];
}
