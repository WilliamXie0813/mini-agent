import { writeFile } from "node:fs/promises";
import type { Tool, ValidationResult } from "../../types.ts";

export interface EditFileParameters {
  path: string;
  content: string;
}

function validateEditFileArguments(
  value: unknown,
): ValidationResult<EditFileParameters> {
  if (
    value === null ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    !("content" in value) ||
    typeof value.content !== "string"
  ) {
    return {
      ok: false,
      error:
        'editFile requires an object with a non-empty string "path" and string "content"',
    };
  }

  return {
    ok: true,
    value: { path: value.path, content: value.content },
  };
}

export const editFile: Tool<EditFileParameters> = {
  name: "editFile",
  description: "Replace a file with the provided UTF-8 content",
  executionMode: "sequential",
  validate: validateEditFileArguments,
  async execute(_toolCallId, parameters, signal) {
    signal.throwIfAborted();

    try {
      await writeFile(parameters.path, parameters.content, {
        encoding: "utf8",
        signal,
      });

      return {
        content: `Updated ${parameters.path}`,
        details: { path: parameters.path },
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Failed to edit ${parameters.path}: ${message}`,
        details: { path: parameters.path },
        isError: true,
      };
    }
  },
};
