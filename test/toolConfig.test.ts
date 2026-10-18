import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidBedrockToolName, toBedrockToolConfig, toMcpToolCall, ToolNameMap, UnknownToolError, UnsafeSchemaError } from "../src/index.ts";
import type { BridgeWarning, McpTool } from "../src/index.ts";

const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const tool = (name: string, extra: Partial<McpTool> = {}): McpTool => ({ name, description: `Tool ${name}`, inputSchema: schema, ...extra });
const quiet = { onWarning: () => {} };

describe("tool names", () => {
  it("keeps valid names", () => {
    const names = new ToolNameMap(["get_user", "DATA-export_v2"]);
    assert.equal(names.toBedrock("get_user"), "get_user");
    assert.equal(names.toBedrock("DATA-export_v2"), "DATA-export_v2");
  });

  it("replaces characters Bedrock doesn't accept", () => {
    const names = new ToolNameMap(["admin.tools.list", "ünicode tool"]);
    assert.equal(names.toBedrock("admin.tools.list"), "admin_tools_list");
    assert.equal(names.toBedrock("ünicode tool"), "_nicode_tool");
    assert.equal(names.toMcp("admin_tools_list"), "admin.tools.list");
  });

  it("shortens names longer than 64 characters with a stable hash", () => {
    const long = `a.${"x".repeat(126)}`;
    const alias = new ToolNameMap([long]).toBedrock(long) ?? "";
    assert.ok(isValidBedrockToolName(alias));
    assert.equal(alias.length, 64);
    assert.equal(new ToolNameMap([long]).toBedrock(long), alias);
  });

  it("never gives two tools the same name", () => {
    const names = new ToolNameMap(["a.b", "a_b", "a-b", "a/b"]);
    const aliases = [...names.entries()].map(([, bedrock]) => bedrock);
    assert.equal(new Set(aliases).size, 4);
    assert.equal(names.toBedrock("a_b"), "a_b");
    for (const alias of aliases) assert.ok(isValidBedrockToolName(alias));
    for (const [mcp, bedrock] of names.entries()) assert.equal(names.toMcp(bedrock), mcp);
  });

  it("gives the same aliases whatever order the server lists its tools in", () => {
    const names = ["a.b", "a:b", "a_c", "x".repeat(70), "x".repeat(70) + "y"];
    const pairs = (list: string[]) => [...new ToolNameMap(list).entries()].sort();
    const expected = pairs(names);
    assert.deepEqual(pairs([...names].reverse()), expected);
    assert.deepEqual(pairs([names[1]!, names[4]!, names[0]!, names[3]!, names[2]!]), expected);
    // entries() still follows the tool list order.
    assert.deepEqual(
      [...new ToolNameMap(["a:b", "a.b"]).entries()].map(([mcp]) => mcp),
      ["a:b", "a.b"],
    );
  });

  it("rejects empty and duplicate names", () => {
    assert.throws(() => new ToolNameMap([""]), TypeError);
    assert.throws(() => new ToolNameMap(["a", "a"]), TypeError);
  });
});

describe("toBedrockToolConfig", () => {
  it("accepts a tools/list result and builds tool specs", () => {
    const { toolConfig, toolNames, warnings } = toBedrockToolConfig({ tools: [tool("orders.get_status")] });
    assert.deepEqual(toolConfig, {
      tools: [{ toolSpec: { name: "orders_get_status", description: "Tool orders.get_status", inputSchema: { json: schema } } }],
    });
    assert.equal(toolNames.toMcp("orders_get_status"), "orders.get_status");
    assert.equal(warnings.length, 0);
  });

  it("uses the title or name when there is no description", () => {
    const { toolConfig } = toBedrockToolConfig([
      { name: "a", title: "Title A", inputSchema: schema },
      { name: "b", description: "  ", inputSchema: schema },
    ]);
    assert.deepEqual(
      toolConfig.tools?.map((t) => t.toolSpec?.description),
      ["Title A", "b"],
    );
  });

  it("skips tools without a name and duplicate tools, with warnings", () => {
    const warnings: BridgeWarning[] = [];
    const { toolConfig } = toBedrockToolConfig([tool("a"), tool("a"), { inputSchema: schema } as unknown as McpTool], {
      onWarning: (w) => warnings.push(w),
    });
    assert.equal(toolConfig.tools?.length, 1);
    assert.deepEqual(
      warnings.map((w) => w.code),
      ["duplicate-tool", "invalid-tool"],
    );
  });

  it("names a tool without a name (unnamed), unquoted, in an UnsafeSchemaError", () => {
    const tools = [{ inputSchema: schema } as unknown as McpTool, tool("(unnamed)", { inputSchema: "x" as never })];
    assert.throws(
      () => toBedrockToolConfig(tools, { ...quiet, onUnsafeSchema: "throw" }),
      (error: unknown) =>
        error instanceof UnsafeSchemaError &&
        error.issues[0]?.tool === "" &&
        error.message ===
          'Tool schemas are not Nova-safe:\n- (unnamed) "/": tool has no name\n- "(unnamed)" "/": inputSchema is not an object',
    );
  });

  it("warns when no tools are left", () => {
    const { toolConfig, warnings } = toBedrockToolConfig([], quiet);
    assert.deepEqual(toolConfig, { tools: [] });
    assert.equal(warnings[0]?.code, "no-tools");
  });

  it("rejects tools that aren't an array or a tools/list result", () => {
    for (const tools of [null, undefined, {}, { tools: {} }, { tools: "ab" }, "ab", 3]) {
      assert.throws(() => toBedrockToolConfig(tools as never, quiet), TypeError);
    }
  });

  it("requires maxSchemaDepth to be an integer from 1 to 256", () => {
    for (const maxSchemaDepth of [0, 257, 1.5, NaN, Infinity, -1, "32"]) {
      assert.throws(() => toBedrockToolConfig([tool("a")], { ...quiet, maxSchemaDepth: maxSchemaDepth as number }), TypeError);
    }
    assert.equal(toBedrockToolConfig([tool("a")], { ...quiet, maxSchemaDepth: 256 }).toolConfig.tools?.length, 1);
    assert.equal(toBedrockToolConfig([tool("a")], { ...quiet, maxSchemaDepth: 1 }).toolConfig.tools?.length, 0);
  });

  it("uses the default maxSchemaDepth when it is null", () => {
    const deep: Record<string, unknown> = { type: "string" };
    let node = deep;
    for (let i = 0; i < 20; i++) node = { type: "object", properties: { n: node } };
    const options = { ...quiet, maxSchemaDepth: null as unknown as number };
    // 20 nested objects are 41 levels deep: past the default of 32.
    assert.equal(toBedrockToolConfig([tool("a", { inputSchema: node })], options).toolConfig.tools?.length, 0);
    assert.equal(toBedrockToolConfig([tool("a")], options).toolConfig.tools?.length, 1);
  });

  it("rejects an onUnsafeSchema that isn't warn, throw or passthrough", () => {
    for (const onUnsafeSchema of ["Throw", "warning", "", 1, true, {}]) {
      assert.throws(
        () => toBedrockToolConfig([tool("a")], { ...quiet, onUnsafeSchema: onUnsafeSchema as never }),
        (error: unknown) => error instanceof TypeError && error.message.includes("onUnsafeSchema"),
      );
    }
  });

  it("uses the warn policy when onUnsafeSchema is null", () => {
    const withRef = tool("a", { inputSchema: { type: "object", properties: { x: { $ref: "#/$defs/X" } } } });
    const { toolConfig, warnings } = toBedrockToolConfig([withRef], { ...quiet, onUnsafeSchema: null as never });
    assert.equal(toolConfig.tools?.length, 0);
    assert.ok(warnings.some((w) => w.code === "tool-excluded"));
  });

  it("doesn't read a tool's fields from a polluted prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.description = "polluted";
    proto.inputSchema = { type: "object", properties: { injected: { type: "string" } } };
    proto.name = "injected";
    try {
      const { toolConfig, warnings } = toBedrockToolConfig([{ title: "T" } as unknown as McpTool, JSON.parse('{"name":"a"}')], quiet);
      assert.deepEqual(warnings.map((w) => w.code), ["invalid-tool"]);
      assert.deepEqual(toolConfig.tools?.[0]?.toolSpec, {
        name: "a",
        description: "a",
        inputSchema: { json: { type: "object", properties: {}, required: [] } },
      });
    } finally {
      delete proto.description;
      delete proto.inputSchema;
      delete proto.name;
    }
  });

  it("sends warnings to console.warn by default", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    toBedrockToolConfig([tool("a", { inputSchema: { type: "object", properties: { o: { type: "object" } } } })]);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /^\[mcp-bedrock-bridge\] .*nested object/);
  });
});

describe("toMcpToolCall", () => {
  const { toolNames } = toBedrockToolConfig([tool("orders.get_status")]);

  it("maps a toolUse back to the MCP name and arguments", () => {
    const call = toMcpToolCall({ name: "orders_get_status", input: { id: "A-1" } }, toolNames);
    assert.deepEqual(call, { name: "orders.get_status", arguments: { id: "A-1" } });
  });

  it("uses empty arguments when the input is missing", () => {
    assert.deepEqual(toMcpToolCall({ name: "orders_get_status", input: undefined }, toolNames).arguments, {});
  });

  it("rejects unknown tools, including the original MCP name", () => {
    assert.throws(() => toMcpToolCall({ name: "delete_everything", input: {} }, toolNames), UnknownToolError);
    assert.throws(() => toMcpToolCall({ name: "orders.get_status", input: {} }, toolNames), UnknownToolError);
    assert.throws(() => toMcpToolCall({ name: undefined, input: {} }, toolNames), UnknownToolError);
  });

  it("rejects the original MCP name of a tool with a hashed alias", () => {
    const long = "x".repeat(70);
    const { toolNames: names } = toBedrockToolConfig([tool("a.b"), tool("a_b"), tool(long)], quiet);
    const hashed = names.toBedrock("a.b");
    assert.match(hashed ?? "", /^a_b_[0-9a-f]{8}$/);
    assert.match(names.toBedrock(long) ?? "", /^x{55}_[0-9a-f]{8}$/);
    assert.equal(toMcpToolCall({ name: hashed, input: {} }, names).name, "a.b");
    // "a_b" is the real a_b tool, never a.b.
    assert.equal(toMcpToolCall({ name: "a_b", input: {} }, names).name, "a_b");
    for (const name of ["a.b", long]) {
      assert.throws(() => toMcpToolCall({ name, input: {} }, names), UnknownToolError);
    }
  });

  it("rejects input that isn't an object", () => {
    for (const input of ["text", 3, null, ["a"]]) {
      assert.throws(() => toMcpToolCall({ name: "orders_get_status", input }, toolNames), TypeError);
    }
  });
});
