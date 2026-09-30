import type { AgentMessage } from "./types.ts";
import type {
  PendingEffect,
  QueueName,
  SessionMetadata,
  SessionRecord,
  SessionRecoveryWarning,
  SessionSnapshot,
} from "./session.ts";

interface ReplayState {
  metadata: SessionMetadata;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  pendingEffects: Map<string, PendingEffect>;
  finishedEffectIds: Set<string>;
  cancelledEffects: PendingEffect[];
}

function createReplayState(
  header: Extract<SessionRecord, { type: "session" }>,
): ReplayState {
  return {
    metadata: {
      ...header.metadata,
      updatedAt: header.metadata.createdAt,
    },
    messages: [],
    steeringQueue: [],
    followUpQueue: [],
    pendingEffects: new Map(),
    finishedEffectIds: new Set(),
    cancelledEffects: [],
  };
}

function queueFor(
  state: ReplayState,
  queue: QueueName,
): AgentMessage[] {
  return queue === "steering"
    ? state.steeringQueue
    : state.followUpQueue;
}

function findQueuedMessage(
  state: ReplayState,
  messageId: string,
): { queue: QueueName; index: number } | undefined {
  const steeringIndex = state.steeringQueue.findIndex(
    (message) => message.id === messageId,
  );
  if (steeringIndex >= 0) {
    return { queue: "steering", index: steeringIndex };
  }

  const followUpIndex = state.followUpQueue.findIndex(
    (message) => message.id === messageId,
  );
  if (followUpIndex >= 0) {
    return { queue: "followUp", index: followUpIndex };
  }
  return undefined;
}

function applyOperation(
  state: ReplayState,
  operation: Extract<
    SessionRecord,
    { type: "commit" }
  >["operations"][number],
): void {
  switch (operation.type) {
    case "message":
      state.messages.push(operation.message);
      return;
    case "queue_enqueued": {
      if (findQueuedMessage(state, operation.message.id)) {
        throw new Error(
          `Queue message already enqueued: ${operation.message.id}`,
        );
      }
      queueFor(state, operation.queue).push(operation.message);
      return;
    }
    case "queue_dequeued": {
      const queue = queueFor(state, operation.queue);
      const index = queue.findIndex(
        (message) => message.id === operation.messageId,
      );
      if (index < 0) {
        throw new Error(
          `Queue message ${operation.messageId} is not enqueued in ${operation.queue}`,
        );
      }
      queue.splice(index, 1);
      return;
    }
    case "effect_started":
      if (
        state.pendingEffects.has(operation.effect.toolCallId) ||
        state.finishedEffectIds.has(operation.effect.toolCallId) ||
        state.cancelledEffects.some(
          (effect) =>
            effect.toolCallId === operation.effect.toolCallId,
        )
      ) {
        throw new Error(
          `Tool effect already recorded: ${operation.effect.toolCallId}`,
        );
      }
      state.pendingEffects.set(
        operation.effect.toolCallId,
        operation.effect,
      );
      return;
    case "effect_finished": {
      const pending = state.pendingEffects.get(operation.toolCallId);
      if (!pending) {
        throw new Error(
          `Pending Tool effect not found: ${operation.toolCallId}`,
        );
      }
      state.pendingEffects.delete(operation.toolCallId);
      state.finishedEffectIds.add(operation.toolCallId);
      return;
    }
    case "effect_cancelled": {
      const pending = state.pendingEffects.get(operation.toolCallId);
      if (!pending) {
        throw new Error(
          `Pending Tool effect not found: ${operation.toolCallId}`,
        );
      }
      state.pendingEffects.delete(operation.toolCallId);
      state.cancelledEffects.push(pending);
      return;
    }
    case "reset":
      state.messages = [operation.systemMessage];
      state.steeringQueue = [];
      state.followUpQueue = [];
      return;
  }
}

function unknownWarning(
  effect: PendingEffect,
): SessionRecoveryWarning {
  return {
    kind: "unknown",
    effect,
    message:
      `Tool ${effect.toolName} (${effect.toolCallId}) started ` +
      "before shutdown; outcome is unknown.",
  };
}

function cancelledWarning(
  effect: PendingEffect,
): SessionRecoveryWarning {
  return {
    kind: "cancelled",
    effect,
    message:
      `Tool ${effect.toolName} (${effect.toolCallId}) was cancelled ` +
      "before producing a committed result.",
  };
}

function createSnapshot(state: ReplayState): SessionSnapshot {
  const pendingEffects = [...state.pendingEffects.values()];
  return {
    metadata: { ...state.metadata },
    messages: state.messages.slice(),
    steeringQueue: state.steeringQueue.slice(),
    followUpQueue: state.followUpQueue.slice(),
    pendingEffects,
    cancelledEffects: state.cancelledEffects.slice(),
    recoveryWarnings: [
      ...pendingEffects.map(unknownWarning),
      ...state.cancelledEffects.map(cancelledWarning),
    ],
  };
}

export function replaySessionRecords(
  records: readonly SessionRecord[],
): SessionSnapshot {
  const firstRecord = records[0];
  if (!firstRecord || firstRecord.type !== "session") {
    throw new Error(
      "Session records must begin with a Session Header",
    );
  }

  const state = createReplayState(firstRecord);
  let expectedSequence = 1;

  for (const record of records.slice(1)) {
    if (record.type === "session") {
      throw new Error(
        "Unexpected Session Header after replay began",
      );
    }
    if (record.sequence !== expectedSequence) {
      throw new Error(
        `Expected Commit sequence ${expectedSequence} but received ${record.sequence}`,
      );
    }

    for (const operation of record.operations) {
      applyOperation(state, operation);
    }
    state.metadata.updatedAt = record.timestamp;
    expectedSequence += 1;
  }

  return createSnapshot(state);
}
