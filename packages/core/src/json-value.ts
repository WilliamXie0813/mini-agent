import type { JsonValue } from "./session.ts";

function isPlainObject(
  value: object,
): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function convertJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Value at ${path} is not JSON-compatible`);
    }
    return value;
  }

  if (typeof value !== "object") {
    throw new Error(`Value at ${path} is not JSON-compatible`);
  }

  if (ancestors.has(value)) {
    throw new Error(`Circular JSON value at ${path}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new Error(
            `Sparse array entry at ${path}[${index}] is not JSON-compatible`,
          );
        }
        result.push(
          convertJsonValue(
            value[index],
            `${path}[${index}]`,
            ancestors,
          ),
        );
      }
      return result;
    }

    if (!isPlainObject(value)) {
      throw new Error(`Value at ${path} is not JSON-compatible`);
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(
        `Symbol-keyed properties are not JSON-compatible at ${path}`,
      );
    }

    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = convertJsonValue(
        item,
        `${path}.${key}`,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function toJsonValue(value: unknown): JsonValue {
  return convertJsonValue(value, "$", new WeakSet<object>());
}
