import type {
  JsonValue,
  PendingEffect,
  QueueName,
  SessionLoadDiagnostic,
  SessionRecord,
  SessionRecoveryWarning,
  SessionSnapshot,
} from "./session.ts";
import type { AgentMessage } from "./types.ts";

export function toJsonValue(value: unknown): JsonValue {
  const visiting = new Set<object>();
  const visit = (candidate: unknown): JsonValue => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new Error("Tool arguments are not JSON serializable");
    }
    if (visiting.has(candidate)) {
      throw new Error("Tool arguments contain a circular reference");
    }
    visiting.add(candidate);
    try {
      if (Array.isArray(candidate)) return candidate.map(visit);
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(candidate)) {
        result[key] = visit(item);
      }
      return result;
    } finally {
      visiting.delete(candidate);
    }
  };
  return visit(value);
}

function warning(
  kind: SessionRecoveryWarning["kind"],
  effect: PendingEffect,
): SessionRecoveryWarning {
  return {
    kind,
    effect,
    message:
      kind === "unknown"
        ? `Tool outcome is unknown: ${effect.toolName} (${effect.toolCallId})`
        : `Tool execution was cancelled: ${effect.toolName} (${effect.toolCallId})`,
  };
}

export function replaySessionRecords(
  records: readonly SessionRecord[],
  loadDiagnostics: SessionLoadDiagnostic[],
): SessionSnapshot {
  const header = records[0];
  if (!header || header.type !== "session" || header.version !== 1) {
    throw new Error("Session file must begin with a version 1 header");
  }

  let messages: AgentMessage[] = [];
  const queues: Record<QueueName, AgentMessage[]> = {
    steering: [],
    followUp: [],
  };
  const pending = new Map<string, PendingEffect>();
  const cancelled = new Map<string, PendingEffect>();
  let expectedSequence = 1;
  let updatedAt = header.metadata.createdAt;

  for (const record of records.slice(1)) {
    if (record.type !== "commit") {
      throw new Error("Session header may only appear once");
    }
    if (record.sequence !== expectedSequence) {
      throw new Error(
        `Expected sequence ${expectedSequence} but received ${record.sequence}`,
      );
    }
    expectedSequence += 1;
    updatedAt = record.timestamp;

    for (const operation of record.operations) {
      switch (operation.type) {
        case "message":
          messages.push(operation.message);
          break;
        case "queue_enqueued":
          queues[operation.queue].push(operation.message);
          break;
        case "queue_dequeued": {
          const queue = queues[operation.queue];
          const index = queue.findIndex(
            (message) => message.id === operation.messageId,
          );
          if (index < 0) {
            throw new Error(
              `Commit references missing queued message: ${operation.messageId}`,
            );
          }
          queue.splice(index, 1);
          break;
        }
        case "effect_started":
          pending.set(operation.effect.toolCallId, operation.effect);
          break;
        case "effect_finished":
          pending.delete(operation.toolCallId);
          break;
        case "effect_cancelled": {
          const effect = pending.get(operation.toolCallId);
          if (!effect) {
            throw new Error(
              `Cancelled effect was not started: ${operation.toolCallId}`,
            );
          }
          pending.delete(operation.toolCallId);
          cancelled.set(operation.toolCallId, effect);
          break;
        }
        case "reset":
          messages = [operation.systemMessage];
          queues.steering = [];
          queues.followUp = [];
          break;
      }
    }
  }

  const pendingEffects = [...pending.values()];
  const cancelledEffects = [...cancelled.values()];
  return {
    metadata: { ...header.metadata, updatedAt },
    messages,
    steeringQueue: queues.steering,
    followUpQueue: queues.followUp,
    pendingEffects,
    cancelledEffects,
    recoveryWarnings: [
      ...pendingEffects.map((effect) => warning("unknown", effect)),
      ...cancelledEffects.map((effect) => warning("cancelled", effect)),
    ],
    loadDiagnostics,
    lastSequence: expectedSequence - 1,
  };
}
