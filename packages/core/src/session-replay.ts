import type { AgentMessage } from "./types.ts";
import type {
  PendingEffect,
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
    case "queue_enqueued":
    case "queue_dequeued":
    case "effect_started":
    case "effect_finished":
    case "effect_cancelled":
    case "reset":
      throw new Error(
        `Session operation is not supported by the current replay slice: ${operation.type}`,
      );
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
