import type { AgentMessage } from "./types.ts";
import type {
  PendingEffect,
  QueueName,
  SessionMetadata,
  SessionRecord,
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
    case "effect_finished":
    case "effect_cancelled":
      throw new Error(
        `Session operation is not supported by the current replay slice: ${operation.type}`,
      );
    case "reset":
      state.messages = [operation.systemMessage];
      state.steeringQueue = [];
      state.followUpQueue = [];
      return;
  }
}

function createSnapshot(state: ReplayState): SessionSnapshot {
  return {
    metadata: { ...state.metadata },
    messages: state.messages.slice(),
    steeringQueue: state.steeringQueue.slice(),
    followUpQueue: state.followUpQueue.slice(),
    pendingEffects: [...state.pendingEffects.values()],
    cancelledEffects: state.cancelledEffects.slice(),
    recoveryWarnings: [],
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
