import type { BridgeWarning } from "./types.ts";

// The library has no Node-specific code. These two globals exist in Node >= 16, browsers,
// Deno, Bun and edge runtimes; declaring them here keeps the build free of DOM or Node types.
declare const console: { warn(...data: unknown[]): void };
declare function atob(data: string): string;

export function warnToConsole(warning: BridgeWarning): void {
  console.warn(`[mcp-bedrock-bridge] ${warning.message}`);
}

/** Decodes base64 to bytes. Throws on invalid input. */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A plain object (`{}` or a null-prototype object), not an array, class instance or null. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reads an own property only, so a polluted Object.prototype can't leak values in. */
export function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * A server- or model-provided string for an error or warning message: cut to `max` characters
 * and JSON-quoted, so a newline in it can't forge extra log lines.
 */
export function quote(text: string, max = 100): string {
  return JSON.stringify(text.slice(0, max));
}

const MAX_DEPTH_OPTION = 256;

/** A depth option: the default when null or undefined, otherwise an integer from 1 to 256. */
export function depthOption(name: string, value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_DEPTH_OPTION) {
    throw new TypeError(`${name} must be an integer from 1 to ${MAX_DEPTH_OPTION}`);
  }
  return value;
}

/** A string option with a fixed set of values: the default when null or undefined. */
export function enumOption<T extends string>(name: string, value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value as T)) {
    throw new TypeError(`${name} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  return value as T;
}

/**
 * The nesting depth of a JSON-like value (objects and arrays count as one level each), or
 * Infinity when it is deeper than `max`. A circular value is reported as Infinity too, because
 * the walk stops at `max` instead of following the cycle.
 */
export function jsonDepth(value: unknown, max: number, depth = 0): number {
  if (typeof value !== "object" || value === null) return depth;
  if (depth + 1 > max) return Infinity;
  let deepest = depth + 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    deepest = Math.max(deepest, jsonDepth(child, max, depth + 1));
    if (deepest === Infinity) break;
  }
  return deepest;
}
