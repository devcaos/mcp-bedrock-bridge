import { quote } from "./runtime.ts";

/** A part of a tool's inputSchema that isn't Nova-safe. */
export interface SchemaIssue {
  /** The MCP tool name, raw (not quoted or cut); "" for a tool without a name. */
  tool: string;
  /** JSON Pointer inside the tool's inputSchema ("" is the root). */
  path: string;
  reason: string;
}

/** Thrown by `toBedrockToolConfig` with `onUnsafeSchema: "throw"`. */
export class UnsafeSchemaError extends Error {
  readonly issues: readonly SchemaIssue[];

  constructor(issues: readonly SchemaIssue[]) {
    const lines = issues.map(
      (issue) => `- ${issue.tool === "" ? "(unnamed)" : quote(issue.tool)} ${quote(issue.path || "/", 200)}: ${issue.reason}`,
    );
    super(`Tool schemas are not Nova-safe:\n${lines.join("\n")}`);
    this.name = "UnsafeSchemaError";
    this.issues = issues;
  }
}

/** Thrown by `toMcpToolCall` when the model asks for a tool that wasn't sent to it. */
export class UnknownToolError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`The model called an unknown tool: ${quote(toolName)}`);
    this.name = "UnknownToolError";
    this.toolName = toolName;
  }
}
