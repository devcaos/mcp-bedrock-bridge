// Structural MCP types: only the fields this library reads. They are deliberately loose, so
// the types from @modelcontextprotocol/sdk (v1) and the v2 packages (@modelcontextprotocol/client)
// are both assignable without a cast. Everything in them comes from an MCP server and is
// validated at runtime, never trusted.

/** A tool from an MCP `tools/list` result. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema for the tool's arguments (MCP requires `type: "object"`). */
  inputSchema?: object;
}

/** An MCP `tools/list` result. */
export interface McpListToolsResult {
  tools: readonly McpTool[];
}

/**
 * One item of `CallToolResult.content`: text, image, audio, resource_link or resource.
 * Kept open (`type: string`) because servers may send types this library doesn't know.
 */
export interface McpContentBlock {
  type: string;
  [key: string]: unknown;
}

/** An MCP `tools/call` result. */
export interface McpCallToolResult {
  content?: readonly McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** The pre-2025 `tools/call` result shape that `Client.callTool` in the v1 SDK may also return. */
export interface McpCompatibilityCallToolResult {
  toolResult: unknown;
}

/** Params for an MCP `tools/call` request, ready for `client.callTool(...)`. */
export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type BridgeWarningCode =
  | "nested-schema"
  | "untyped-schema"
  | "map-schema"
  | "unsupported-schema"
  | "schema-too-deep"
  | "invalid-tool"
  | "duplicate-tool"
  | "tool-excluded"
  | "no-tools"
  | "content-omitted";

/** Something the library changed or dropped. Never contains argument values or result data. */
export interface BridgeWarning {
  code: BridgeWarningCode;
  message: string;
  /** MCP tool name, when the warning is about a tool definition. */
  tool?: string;
  /** JSON Pointer inside the tool's inputSchema. */
  path?: string;
  /** Bedrock toolUseId, when the warning is about a tool result. */
  toolUseId?: string;
}

export type WarningHandler = (warning: BridgeWarning) => void;
