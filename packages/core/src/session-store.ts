import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  JsonValue,
  PendingEffect,
  QueueName,
  SessionLoadDiagnostic,
  SessionMetadata,
  SessionRecord,
  SessionRecoveryWarning,
  SessionSnapshot,
  SessionStore,
} from "./session.ts";
import type { AgentMessage } from "./types.ts";

/**
 * 将任意未知值深度转换为 JsonValue（只含 null/字符串/布尔/有限数字/数组/纯对象）。
 *
 * 用途：工具参数来自外部输入，写入 session 文件前必须保证可 JSON 序列化。
 * - visiting 集合用于检测循环引用（重复对象但非循环是允许的，离开分支后即删除）；
 * - 遇到函数、undefined、Symbol、BigInt、NaN/Infinity 等无法序列化的值时抛错。
 */
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

/**
 * 为恢复时残留的未决副作用生成一条警告。
 *
 * - kind = "unknown"：副作用开始了但没有结束记录（比如进程中途崩溃），
 *   工具到底执行成功没有，无从得知；
 * - kind = "cancelled"：副作用被显式取消，结果已知为未执行。
 */
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

/**
 * 重放 session 记录（事件溯源），把文件中的一串操作还原成完整的 SessionSnapshot。
 *
 * 输入：
 * - records：session 文件的全部记录。第一条必须是 version 1 的 header，
 *   其余是严格按 sequence 递增的 commit（乱序/缺号/重复 header 都会抛错，
 *   因为这意味着文件损坏）。
 * - loadDiagnostics：文件加载阶段已经产生的诊断（如跳过损坏行），透传到快照中。
 *
 * 重放逻辑：从空状态开始，逐条应用每个 commit 里的操作：
 * - message：追加到对话消息列表；
 * - queue_enqueued / queue_dequeued：维护 steering / followUp 两个待处理队列；
 * - effect_started / effect_finished：维护"进行中的副作用"集合；
 * - effect_cancelled：把副作用从进行中移到已取消集合（未开始就取消属于数据损坏，抛错）；
 * - reset：压缩/重置事件——消息列表替换为新的 systemMessage，两个队列清空。
 *
 * 重放结束后仍留在 pending 里的副作用，说明进程在工具执行中途退出，
 * 为它们生成 "unknown" 警告；已取消的生成 "cancelled" 警告，
 * 一并放进快照的 recoveryWarnings 供上层决定如何处理。
 */
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

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord[]>();
  private nextAppendFailure?: Error;

  failNextAppend(error = new Error("Session append failed")): void {
    this.nextAppendFailure = error;
  }

  async create(metadata: SessionMetadata): Promise<void> {
    if (this.sessions.has(metadata.id)) {
      throw new Error(`Session already exists: ${metadata.id}`);
    }
    this.sessions.set(metadata.id, [
      { type: "session", version: 1, metadata: { ...metadata } },
    ]);
  }

  async load(sessionId: string): Promise<SessionSnapshot> {
    const records = this.sessions.get(sessionId);
    if (!records) throw new SessionNotFoundError(sessionId);
    return replaySessionRecords(structuredClone(records), []);
  }

  async append(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) throw new SessionNotFoundError(sessionId);
    if (this.nextAppendFailure) {
      const failure = this.nextAppendFailure;
      this.nextAppendFailure = undefined;
      throw failure;
    }
    existing.push(...structuredClone(records));
  }

  async list(): Promise<SessionMetadata[]> {
    return Promise.all(
      [...this.sessions.keys()].map(async (id) => (await this.load(id)).metadata),
    );
  }
}

export class JsonlSessionStore implements SessionStore {
  private readonly sessionsDir: string;

  constructor(dataDir: string) {
    if (!isAbsolute(dataDir)) {
      throw new Error("JsonlSessionStore dataDir must be absolute");
    }
    this.sessionsDir = join(dataDir, "sessions");
  }

  private path(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  async create(metadata: SessionMetadata): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const header: SessionRecord = {
      type: "session",
      version: 1,
      metadata,
    };
    await writeFile(this.path(metadata.id), `${JSON.stringify(header)}\n`, {
      flag: "wx",
    });
  }

  async load(sessionId: string): Promise<SessionSnapshot> {
    let content: string;
    try {
      content = await readFile(this.path(sessionId), "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }

    const diagnostics: SessionLoadDiagnostic[] = [];
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const records: SessionRecord[] = [];
    for (const [index, line] of lines.entries()) {
      try {
        records.push(JSON.parse(line) as SessionRecord);
      } catch (error) {
        if (index === lines.length - 1 && !content.endsWith("\n")) {
          diagnostics.push({
            kind: "truncated_tail",
            message: `Ignored truncated final line for session ${sessionId}`,
          });
          break;
        }
        throw new Error(
          `Invalid JSONL at ${sessionId}:${index + 1}`,
          { cause: error },
        );
      }
    }
    return replaySessionRecords(records, diagnostics);
  }

  async append(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void> {
    if (records.length === 0) return;
    await appendFile(
      this.path(sessionId),
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
      "utf8",
    );
  }

  async list(): Promise<SessionMetadata[]> {
    try {
      const names = await readdir(this.sessionsDir);
      const snapshots = await Promise.all(
        names
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => this.load(name.slice(0, -".jsonl".length))),
      );
      return snapshots
        .map((snapshot) => snapshot.metadata)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
  }
}
