import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toBedrockToolConfig, UnsafeSchemaError } from "../src/index.ts";
import type { BridgeWarning, McpTool, ToBedrockToolConfigOptions } from "../src/index.ts";

// Converts one tool and returns its Bedrock schema (undefined if it was left out) and warnings.
function convert(inputSchema: unknown, options: ToBedrockToolConfigOptions = {}) {
  const warnings: BridgeWarning[] = [];
  const { toolConfig } = toBedrockToolConfig([{ name: "tool", description: "A tool.", inputSchema } as McpTool], {
    onWarning: (w) => warnings.push(w),
    ...options,
  });
  const json = toolConfig.tools?.[0]?.toolSpec?.inputSchema?.json as Record<string, unknown> | undefined;
  return { schema: json, warnings };
}

describe("Nova-safe input schemas", () => {
  it("adds a missing required array", () => {
    const { schema, warnings } = convert({ type: "object", properties: { q: { type: "string" } } });
    assert.deepEqual(schema, { type: "object", properties: { q: { type: "string" } }, required: [] });
    assert.equal(warnings.length, 0);
  });

  it("keeps required fields and drops names that aren't properties", () => {
    const { schema } = convert({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "missing", "a", 3],
    });
    assert.deepEqual(schema?.required, ["a"]);
  });

  it("keeps only type, properties and required at the root", () => {
    const { schema } = convert({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      description: "root description",
      additionalProperties: false,
      properties: {},
    });
    assert.deepEqual(schema, { type: "object", properties: {}, required: [] });
  });

  it("turns a missing inputSchema into an empty object schema", () => {
    const { schema } = convert(undefined);
    assert.deepEqual(schema, { type: "object", properties: {}, required: [] });
  });

  it("drops validation keywords and keeps type, description, enum and items", () => {
    const { schema } = convert({
      type: "object",
      properties: {
        email: { type: "string", format: "email", minLength: 3, pattern: ".+@.+", description: "Email" },
        tags: { type: "array", items: { type: "string", maxLength: 10 }, minItems: 1 },
        level: { type: "string", enum: ["low", "high"], default: "low" },
      },
      required: ["email"],
    });
    assert.deepEqual(schema?.properties, {
      email: { type: "string", description: "Email" },
      tags: { type: "array", items: { type: "string" } },
      level: { type: "string", enum: ["low", "high"] },
    });
  });

  it("collapses nullable types and anyOf with null", () => {
    const { schema, warnings } = convert({
      type: "object",
      properties: {
        a: { type: ["string", "null"] },
        b: { anyOf: [{ type: "number" }, { type: "null" }], description: "B" },
      },
    });
    assert.deepEqual(schema?.properties, { a: { type: "string" }, b: { type: "number", description: "B" } });
    assert.equal(warnings.length, 0);
  });

  it("turns const into a one-value enum and infers missing types", () => {
    const { schema } = convert({ type: "object", properties: { mode: { const: "fast" }, n: { enum: [1, 2] } } });
    assert.deepEqual(schema?.properties, {
      mode: { type: "string", enum: ["fast"] },
      n: { type: "integer", enum: [1, 2] },
    });
  });

  it("warns about nested objects but keeps them, made safe", () => {
    const { schema, warnings } = convert({
      type: "object",
      properties: {
        address: { type: "object", properties: { city: { type: "string" } }, additionalProperties: false },
      },
    });
    assert.deepEqual(schema?.properties, {
      address: { type: "object", properties: { city: { type: "string" } }, required: [] },
    });
    assert.deepEqual(
      warnings.map((w) => [w.code, w.path]),
      [["nested-schema", "/properties/address"]],
    );
  });

  it("warns about arrays of objects", () => {
    const { warnings } = convert({
      type: "object",
      properties: { rows: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } },
    });
    assert.deepEqual(
      warnings.map((w) => w.path),
      ["/properties/rows/items"],
    );
  });

  it("throws on a nested object with onUnsafeSchema: throw", () => {
    assert.throws(
      () => convert({ type: "object", properties: { a: { type: "object", properties: {} } } }, { onUnsafeSchema: "throw" }),
      (error: unknown) =>
        error instanceof UnsafeSchemaError && error.issues.length === 1 && error.issues[0]?.path === "/properties/a",
    );
  });

  it("leaves out a tool with $ref or oneOf (warn)", () => {
    for (const field of [{ $ref: "#/$defs/x" }, { oneOf: [{ type: "string" }, { type: "number" }] }]) {
      const { schema, warnings } = convert({ type: "object", properties: { field } });
      assert.equal(schema, undefined);
      assert.ok(warnings.some((w) => w.code === "unsupported-schema"));
      assert.ok(warnings.some((w) => w.code === "tool-excluded"));
    }
  });

  it("sends unsupported parts unchanged with onUnsafeSchema: passthrough", () => {
    const field = { oneOf: [{ type: "string" }, { type: "number" }] };
    const { schema, warnings } = convert(
      { type: "object", properties: { field }, required: ["field"], additionalProperties: false },
      { onUnsafeSchema: "passthrough" },
    );
    assert.deepEqual(schema, { type: "object", properties: { field }, required: ["field"] });
    assert.ok(warnings[0]?.message.includes("sent unchanged"));
  });

  it("leaves out a tool whose root isn't an object schema", () => {
    const { schema } = convert({ type: "array", items: { type: "string" } });
    assert.equal(schema, undefined);
  });
});

describe("untrusted schemas", () => {
  it("keeps a property named __proto__ as a plain key without touching Object.prototype", () => {
    const inputSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string","polluted":true},"constructor":{"type":"number"}},"required":["__proto__"]}',
    );
    const { schema } = convert(inputSchema);
    const properties = schema?.properties as Record<string, unknown>;
    assert.ok(Object.hasOwn(properties, "__proto__"));
    assert.deepEqual(Object.keys(properties), ["__proto__", "constructor"]);
    assert.deepEqual(schema?.required, ["__proto__"]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(properties), Object.prototype);
    // It serializes as a property, which is what the AWS SDK sends.
    assert.equal(
      JSON.stringify(properties),
      '{"__proto__":{"type":"string"},"constructor":{"type":"number"}}',
    );
  });

  it("ignores inherited values from a polluted prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.type = "array";
    try {
      const { schema } = convert({ type: "object", properties: { a: { description: "no type" } } });
      assert.deepEqual(schema?.properties, { a: { description: "no type" } });
    } finally {
      delete proto.type;
    }
  });

  // A chain of arrays: each `items` adds one level of JSON nesting.
  function deepSchema(levels: number): Record<string, unknown> {
    let node: Record<string, unknown> = { type: "string" };
    while (levels-- > 0) node = { type: "array", items: node };
    return { type: "object", properties: { deep: node } };
  }

  it("treats a schema deeper than maxSchemaDepth as unsafe", () => {
    // 1 (root) + 1 (properties) + 31 (deep/items...) = 33 levels.
    const tooDeep = deepSchema(30);
    const ok = convert(deepSchema(29));
    assert.ok(ok.schema);
    const { schema, warnings } = convert(tooDeep);
    assert.equal(schema, undefined);
    assert.ok(warnings.some((w) => w.code === "schema-too-deep"));
    assert.equal(convert(tooDeep, { onUnsafeSchema: "passthrough" }).schema, undefined);
    assert.throws(() => convert(tooDeep, { onUnsafeSchema: "throw" }), UnsafeSchemaError);
    assert.ok(convert(tooDeep, { maxSchemaDepth: 40 }).schema);
  });

  it("doesn't hang on a circular schema", () => {
    const node: Record<string, unknown> = { type: "array" };
    node.items = node;
    const { schema, warnings } = convert({ type: "object", properties: { loop: node } });
    assert.equal(schema, undefined);
    assert.ok(warnings.some((w) => w.code === "schema-too-deep"));
  });
});
