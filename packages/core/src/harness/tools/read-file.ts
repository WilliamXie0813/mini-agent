import { readFile as readFileFromDisk } from "node:fs/promises";
import type { Tool, ValidationResult } from "../../types.ts";

export interface ReadFileParameters {
  path: string;
}

function validateReadFileArguments(
  value: unknown,
): ValidationResult<ReadFileParameters> {
  if (
    value === null ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    value.path.length === 0
  ) {
    return {
      ok: false,
      error: 'readFile requires an object with a non-empty string "path"',
    };
  }

  return { ok: true, value: { path: value.path } };
}

export const readFile: Tool<ReadFileParameters> = {
  name: "readFile",
  description: "Read the UTF-8 contents of a file",
  executionMode: "parallel",
  validate: validateReadFileArguments,
  async execute(_toolCallId, parameters, signal) {
    signal.throwIfAborted();

    try {
      const content = await readFileFromDisk(parameters.path, {
        encoding: "utf8",
        signal,
      });

      return {
        content,
        details: { path: parameters.path },
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Failed to read ${parameters.path}: ${message}`,
        details: { path: parameters.path },
        isError: true,
      };
    }
  },
};
