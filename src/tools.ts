import type { Tool, ValidationResult } from "./types.ts";

export interface ReadParameters {
  path: string;
}

function validateReadArguments(value: unknown): ValidationResult<ReadParameters> {
  if (
    value === null ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string"
  ) {
    return {
      ok: false,
      error: 'read requires an object with a string "path"',
    };
  }

  return { ok: true, value: { path: value.path } };
}

export function createReadTool(files: Readonly<Record<string, string>>): Tool<ReadParameters> {
  return {
    name: "read",
    description: "Read a UTF-8 file from the virtual file system",
    validate: validateReadArguments,
    async execute(_toolCallId, parameters, signal, onUpdate) {
      signal.throwIfAborted();
      await onUpdate({ content: `Reading ${parameters.path}` });
      signal.throwIfAborted();

      const content = files[parameters.path];
      if (content === undefined) {
        return {
          content: `File not found: ${parameters.path}`,
          details: { path: parameters.path },
          isError: true,
        };
      }

      return {
        content,
        details: { path: parameters.path },
        isError: false,
      };
    },
  };
}
