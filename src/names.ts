// Bedrock tool names must match [a-zA-Z0-9_-]+ and be 1-64 characters long (Bedrock API
// Reference, ToolSpecification). MCP allows dots and up to 128 characters, so some MCP names
// need a Bedrock alias. The aliases are deterministic: the same tool list always gives the
// same names, which keeps prompts (and prompt caches) stable.

import { quote } from "./runtime.ts";

const BEDROCK_TOOL_NAME =/^[a-zA-Z0-9_-]{1,64}$/;
const MAX_LENGTH = 64;
// Room for "_" + 8 hex characters of hash.
const HASHED_PREFIX_LENGTH = MAX_LENGTH - 9;

export function isValidBedrockToolName(name: string): boolean {
  return BEDROCK_TOOL_NAME.test(name);
}

/** A two-way map between MCP tool names and the names sent to Bedrock. */
export class ToolNameMap {
  readonly #toBedrock = new Map<string, string>();
  readonly #toMcp = new Map<string, string>();

  /**
   * Builds aliases for a list of unique, non-empty MCP tool names. Names that are already valid
   * keep their name; the others get `_` for each invalid character and, if that is too long or
   * taken, a truncated name plus a hash of the original name.
   * Aliases are assigned in sorted name order, so they don't depend on the order the server
   * lists its tools in. Adding or removing a tool can still change another tool's alias when
   * their names collide after sanitizing.
   */
  constructor(mcpNames: Iterable<string>) {
    const names = [...mcpNames];
    const invalid: string[] = [];
    for (const name of names) {
      if (typeof name !== "string" || name.length === 0) throw new TypeError("Tool names must be non-empty strings");
      if (this.#toBedrock.has(name)) throw new TypeError(`Duplicate tool name: ${quote(name)}`);
      // Valid names are reserved first, so an alias never takes a real tool's name.
      if (isValidBedrockToolName(name)) this.#add(name, name);
      else {
        // Placeholder: keeps entries() in tool-list order.
        this.#toBedrock.set(name, "");
        invalid.push(name);
      }
    }
    // Default sort compares UTF-16 code units: the same in every runtime and locale.
    for (const name of invalid.sort()) this.#add(name, this.#aliasFor(name));
  }

  /** The Bedrock name for an MCP tool name, or undefined if the tool isn't in the map. */
  toBedrock(mcpName: string): string | undefined {
    return this.#toBedrock.get(mcpName);
  }

  /** The MCP name for a Bedrock tool name (e.g. `toolUse.name`), or undefined if unknown. */
  toMcp(bedrockName: string): string | undefined {
    return this.#toMcp.get(bedrockName);
  }

  /** [mcpName, bedrockName] pairs, in the order of the tool list. */
  entries(): IterableIterator<[string, string]> {
    return this.#toBedrock.entries();
  }

  get size(): number {
    return this.#toBedrock.size;
  }

  #add(mcpName: string, bedrockName: string) {
    this.#toBedrock.set(mcpName, bedrockName);
    this.#toMcp.set(bedrockName, mcpName);
  }

  #aliasFor(mcpName: string): string {
    const sanitized = mcpName.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (sanitized.length <= MAX_LENGTH && !this.#toMcp.has(sanitized)) return sanitized;
    const prefix = sanitized.slice(0, HASHED_PREFIX_LENGTH);
    for (let attempt = 0; ; attempt++) {
      const alias = `${prefix}_${fnv1a(attempt === 0 ? mcpName : `${mcpName}#${attempt}`)}`;
      if (!this.#toMcp.has(alias)) return alias;
    }
  }
}

// 32-bit FNV-1a over UTF-16 code units, as 8 hex characters. Not cryptographic: it only has to
// be short, stable and portable (no node:crypto).
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
