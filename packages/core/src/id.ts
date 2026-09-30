import { randomUUID } from "node:crypto";
import type { IdGenerator } from "./types.ts";

export const defaultIdGenerator: IdGenerator = () => randomUUID();

export function validateMessageId(id: string): string {
  if (id.trim().length === 0) {
    throw new Error("Message ID must be non-empty");
  }
  return id;
}

export function generateMessageId(idGenerator: IdGenerator): string {
  return validateMessageId(idGenerator());
}
