import type {
  MessageCommit,
  OpenedSession,
  PendingEffect,
  QueueName,
  SessionCommitter,
  SessionOperation,
  SessionStore,
} from "./session.ts";
import { SessionNotFoundError } from "./session-store.ts";
import type { AgentMessage, SystemMessage } from "./types.ts";

export function createSessionCommitter(options: {
  store: SessionStore;
  sessionId: string;
  initialSequence: number;
  now?: () => Date;
}): SessionCommitter {
  const now = options.now ?? (() => new Date());
  let sequence = options.initialSequence;
  let tail = Promise.resolve();

  const append = (operations: SessionOperation[]): Promise<void> => {
    const operation = async () => {
      const nextSequence = sequence + 1;
      await options.store.append(options.sessionId, [
        {
          type: "commit",
          sequence: nextSequence,
          timestamp: now().toISOString(),
          operations,
        },
      ]);
      sequence = nextSequence;
    };
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    commitMessages(commit: MessageCommit) {
      return append([
        ...(commit.dequeued ?? []).map(
          ({ queue, message }): SessionOperation => ({
            type: "queue_dequeued",
            queue,
            messageId: message.id,
          }),
        ),
        ...commit.messages.map(
          (message): SessionOperation => ({ type: "message", message }),
        ),
      ]);
    },
    enqueue(queue: QueueName, message: AgentMessage) {
      return append([{ type: "queue_enqueued", queue, message }]);
    },
    startEffect(effect: PendingEffect) {
      return append([{ type: "effect_started", effect }]);
    },
    finishEffect(toolCallId: string) {
      return append([{ type: "effect_finished", toolCallId }]);
    },
    cancelEffect(toolCallId: string) {
      return append([{ type: "effect_cancelled", toolCallId }]);
    },
    reset(systemMessage: SystemMessage) {
      return append([{ type: "reset", systemMessage }]);
    },
  };
}

export async function openOrCreateSession(options: {
  store: SessionStore;
  sessionId: string;
  systemMessage: SystemMessage;
  now?: () => Date;
}): Promise<OpenedSession> {
  try {
    const snapshot = await options.store.load(options.sessionId);
    return {
      snapshot,
      committer: createSessionCommitter({
        store: options.store,
        sessionId: options.sessionId,
        initialSequence: snapshot.lastSequence,
        now: options.now,
      }),
    };
  } catch (error) {
    if (!(error instanceof SessionNotFoundError)) throw error;
  }

  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  await options.store.create({
    id: options.sessionId,
    createdAt,
    updatedAt: createdAt,
  });
  const committer = createSessionCommitter({
    store: options.store,
    sessionId: options.sessionId,
    initialSequence: 0,
    now,
  });
  await committer.commitMessages({ messages: [options.systemMessage] });
  return {
    snapshot: await options.store.load(options.sessionId),
    committer,
  };
}
