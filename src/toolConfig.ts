import type { Tool, ToolConfiguration, ToolInputSchema, ToolUseBlock } from "@aws-sdk/client-bedrock-runtime";
import { UnknownToolError, UnsafeSchemaError } from "./errors.ts";
import type { SchemaIssue } from "./errors.ts";
import { ToolNameMap } from "./names.ts";
import { depthOption, isPlainObject, own, warnToConsole } from "./runtime.ts";
import { sanitizeInputSchema } from "./schema.ts";
import type { UnsafeSchemaPolicy } from "./schema.ts";
import type { BridgeWarning, McpListToolsResult, McpTool, McpToolCall, WarningHandler } from "./types.ts";

export interface ToBedrockToolConfigOptions {
  /**
   * What to do with a schema that isn't Nova-safe (default "warn"):
   * - "warn": nested objects, untyped properties and maps are kept (made safe recursively) with a
   *   warning; a tool with a part that can't be converted ($ref, anyOf/oneOf/allOf/not, union
   *   types) is left out of the toolConfig, with a warning.
   * - "throw": throw an UnsafeSchemaError listing every problem, in any tool.
   * - "passthrough": like "warn", but parts that can't be converted are sent unchanged.
   * Under every policy, a tool with a root-level problem (non-object root, $ref or a combinator
   * at the root, properties that isn't an object) or a schema deeper than maxSchemaDepth is
   * never sent.
   */
  onUnsafeSchema?: UnsafeSchemaPolicy;
  /**
   * Maximum JSON nesting depth of an inputSchema, an integer from 1 to 256 (default 32). Deeper
   * or circular schemas are unsafe.
   */
  maxSchemaDepth?: number;
  /** Called for every warning (default: console.warn). Pass `() => {}` to silence them. */
  onWarning?: WarningHandler;
}

export interface BedrockToolConfigResult {
  /** Pass this as `toolConfig` to ConverseCommand (add `toolChoice` if you need one). */
  toolConfig: ToolConfiguration;
  /** MCP name <-> Bedrock name, for `toMcpToolCall`. */
  toolNames: ToolNameMap;
  /** Everything that was changed or left out (also sent to onWarning). */
  warnings: BridgeWarning[];
}

const DEFAULT_MAX_SCHEMA_DEPTH = 32;

/**
 * Converts MCP tools (a `tools/list` result or its `tools` array) into a Bedrock Converse
 * toolConfig with Nova-safe input schemas and Bedrock-valid tool names.
 */
export function toBedrockToolConfig(
  tools: readonly McpTool[] | McpListToolsResult,
  options: ToBedrockToolConfigOptions = {},
): BedrockToolConfigResult {
  const policy = options.onUnsafeSchema ?? "warn";
  const maxDepth = depthOption("maxSchemaDepth", options.maxSchemaDepth, DEFAULT_MAX_SCHEMA_DEPTH);
  const onWarning = options.onWarning ?? warnToConsole;
  const list = toolList(tools);

  const warnings: BridgeWarning[] = [];
  const warn = (warning: BridgeWarning) => {
    warnings.push(warning);
    onWarning(warning);
  };
  const issues: SchemaIssue[] = [];
  const accepted: { name: string; description: string; schema: Record<string, unknown> }[] = [];
  const seen = new Set<string>();

  for (const tool of list) {
    // Own properties only: a polluted Object.prototype can't add a name, description or schema.
    const fields = typeof tool === "object" && tool !== null ? (tool as Record<string, unknown>) : {};
    const rawName = own(fields, "name");
    const name = typeof rawName === "string" ? rawName : "";
    if (name.length === 0) {
      if (policy === "throw") issues.push({ tool: "(unnamed)", path: "", reason: "tool has no name" });
      else warn({ code: "invalid-tool", message: "Skipped a tool without a name." });
      continue;
    }
    if (seen.has(name)) {
      warn({ code: "duplicate-tool", tool: name, message: `Skipped a second tool named ${quote(name)}.` });
      continue;
    }
    seen.add(name);

    const { schema, problems } = sanitizeInputSchema(own(fields, "inputSchema"), {
      maxDepth,
      passthrough: policy === "passthrough",
    });
    if (policy === "throw") {
      issues.push(...problems.map(({ path, reason }) => ({ tool: name, path, reason })));
      if (problems.length === 0) accepted.push({ name, description: descriptionOf(fields, name), schema });
      continue;
    }
    const excluded = problems.some((p) => p.excludesTool || (p.fatal && policy === "warn"));
    for (const problem of problems) {
      warn({
        code: problem.code,
        tool: name,
        path: problem.path,
        message: `${quote(name)} ${problem.path || "/"}: ${problem.reason}${
          problem.fatal && !excluded ? " (sent unchanged)" : ""
        }.`,
      });
    }
    if (excluded) {
      warn({ code: "tool-excluded", tool: name, message: `Left ${quote(name)} out of the toolConfig: its schema isn't Nova-safe.` });
      continue;
    }
    accepted.push({ name, description: descriptionOf(fields, name), schema });
  }

  if (issues.length > 0) throw new UnsafeSchemaError(issues);
  if (accepted.length === 0) warn({ code: "no-tools", message: "No tools left: don't send an empty toolConfig." });

  const toolNames = new ToolNameMap(accepted.map((tool) => tool.name));
  const bedrockTools: Tool[] = accepted.map((tool) => ({
    toolSpec: {
      name: toolNames.toBedrock(tool.name),
      description: tool.description,
      inputSchema: { json: tool.schema } as ToolInputSchema,
    },
  }));
  return { toolConfig: { tools: bedrockTools }, toolNames, warnings };
}

/**
 * Maps a Bedrock `toolUse` block back to MCP `tools/call` params (original name and arguments).
 * Throws UnknownToolError if the model called a tool that isn't in `toolNames`: models can
 * hallucinate tool calls, so never forward an unknown name to the server.
 */
export function toMcpToolCall(toolUse: Pick<ToolUseBlock, "name" | "input">, toolNames: ToolNameMap): McpToolCall {
  const bedrockName = toolUse.name ?? "";
  const name = toolNames.toMcp(bedrockName);
  if (name === undefined) throw new UnknownToolError(bedrockName);
  const input: unknown = toolUse.input === undefined ? {} : toolUse.input;
  if (!isPlainObject(input)) throw new TypeError(`The model's input for ${quote(name)} is not an object`);
  return { name, arguments: input };
}

// The tools array, from a tools/list result or the array itself.
function toolList(tools: unknown): readonly unknown[] {
  if (Array.isArray(tools)) return tools;
  if (typeof tools === "object" && tools !== null) {
    const list = own(tools as Record<string, unknown>, "tools");
    if (Array.isArray(list)) return list;
  }
  throw new TypeError("tools must be a tools/list result ({ tools: [...] }) or its tools array");
}

// Bedrock requires a non-empty description when one is sent.
function descriptionOf(tool: Record<string, unknown>, name: string): string {
  for (const text of [own(tool, "description"), own(tool, "title")]) {
    if (typeof text === "string" && text.trim().length > 0) return text;
  }
  return name;
}

function quote(name: string): string {
  return JSON.stringify(name.slice(0, 100));
}
