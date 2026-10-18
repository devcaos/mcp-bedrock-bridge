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

  it("collapses a nullable pair with annotations, as Pydantic writes Optional[...] = None", () => {
    const { schema, warnings } = convert({
      type: "object",
      properties: {
        // The exact shape Pydantic v2 (and so FastMCP) emits for `x: str | None = None`.
        x: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "X" },
        y: {
          anyOf: [{ type: "integer" }, { type: "null" }],
          default: null,
          description: "How many",
          examples: [3],
          title: "Y",
          deprecated: false,
          readOnly: false,
          writeOnly: false,
          $comment: "c",
        },
      },
      title: "fArguments",
    });
    assert.deepEqual(schema?.properties, { x: { type: "string" }, y: { type: "integer", description: "How many" } });
    assert.equal(warnings.length, 0);
  });

  it("still rejects a nullable pair next to a keyword that isn't an annotation", () => {
    const { schema, warnings } = convert({
      type: "object",
      properties: { x: { anyOf: [{ type: "string" }, { type: "null" }], minLength: 1 } },
    });
    assert.equal(schema, undefined);
    assert.deepEqual(
      warnings.map((w) => w.code),
      ["unsupported-schema", "tool-excluded", "no-tools"],
    );
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

  it("drops null from the enum of a collapsed nullable type", () => {
    const { schema } = convert({
      type: "object",
      properties: {
        a: { type: ["string", "null"], enum: ["x", "y", null] },
        b: { anyOf: [{ type: "string", enum: ["x", null] }, { type: "null" }] },
        c: { type: ["string", "null"], enum: [null] },
      },
    });
    assert.deepEqual(schema?.properties, {
      a: { type: "string", enum: ["x", "y"] },
      b: { type: "string", enum: ["x"] },
      c: { type: "string" },
    });
  });
});

describe("root-level problems, untyped properties and maps", () => {
  const rootProblems: [string, unknown][] = [
    ["$ref at the root", { $ref: "#/definitions/X", definitions: { X: { type: "object" } } }],
    ["anyOf at the root", { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }], properties: { a: { type: "string" } } }],
    ["a non-object root", { type: "array", items: { type: "string" } }],
    ["an inputSchema that isn't an object", "not a schema"],
    ["properties that isn't an object", { type: "object", properties: "x" }],
  ];

  for (const [label, inputSchema] of rootProblems) {
    it(`leaves out a tool with ${label} under every policy`, () => {
      for (const policy of ["warn", "passthrough"] as const) {
        const { schema, warnings } = convert(inputSchema, { onUnsafeSchema: policy });
        assert.equal(schema, undefined, policy);
        assert.ok(warnings.some((w) => w.code === "unsupported-schema"), policy);
        assert.ok(warnings.some((w) => w.code === "tool-excluded"), policy);
        assert.ok(!warnings.some((w) => w.message.includes("sent unchanged")), policy);
      }
      assert.throws(() => convert(inputSchema, { onUnsafeSchema: "throw" }), UnsafeSchemaError);
    });
  }

  it("still sends a nested unsupported part unchanged with passthrough when the root is fine", () => {
    const field = { anyOf: [{ type: "string" }, { type: "number" }] };
    const { schema, warnings } = convert({ type: "object", properties: { field } }, { onUnsafeSchema: "passthrough" });
    assert.deepEqual(schema?.properties, { field });
    assert.deepEqual(
      warnings.map((w) => w.code),
      ["unsupported-schema"],
    );
  });

  it("reports untyped properties as untyped-schema and keeps them under warn and passthrough", () => {
    const inputSchema = { type: "object", properties: { any: { description: "Anything" }, t: true } };
    for (const policy of ["warn", "passthrough"] as const) {
      const { schema, warnings } = convert(inputSchema, { onUnsafeSchema: policy });
      assert.deepEqual(schema?.properties, { any: { description: "Anything" }, t: {} }, policy);
      assert.deepEqual(
        warnings.map((w) => [w.code, w.path]),
        [
          ["untyped-schema", "/properties/any"],
          ["untyped-schema", "/properties/t"],
        ],
        policy,
      );
    }
    assert.throws(
      () => convert(inputSchema, { onUnsafeSchema: "throw" }),
      (error: unknown) => error instanceof UnsafeSchemaError && error.issues.length === 2,
    );
  });

  it("warns when a map's additionalProperties is dropped", () => {
    const { schema, warnings } = convert({
      type: "object",
      properties: { tags: { type: "object", additionalProperties: { type: "string" } } },
    });
    assert.deepEqual(schema?.properties, { tags: { type: "object", properties: {}, required: [] } });
    assert.deepEqual(
      warnings.map((w) => [w.code, w.path]),
      [
        ["nested-schema", "/properties/tags"],
        ["map-schema", "/properties/tags/additionalProperties"],
      ],
    );
    const root = convert({ type: "object", additionalProperties: true });
    assert.deepEqual(
      root.warnings.map((w) => [w.code, w.path]),
      [["map-schema", "/additionalProperties"]],
    );
    assert.throws(() => convert({ type: "object", additionalProperties: {} }, { onUnsafeSchema: "throw" }), UnsafeSchemaError);
  });

  it("doesn't warn about additionalProperties: false or an object that has properties", () => {
    assert.equal(convert({ type: "object", properties: {}, additionalProperties: false }).warnings.length, 0);
    assert.equal(convert({ type: "object", properties: { a: { type: "string" } }, additionalProperties: true }).warnings.length, 0);
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

  it("quotes tool names and paths in warnings and errors, so a newline can't forge a log line", () => {
    const evil = { name: "evil\nFAKE LOG LINE", description: "x", inputSchema: { type: "object", properties: { "p\nINJECTED": { $ref: "#" } } } };
    const warnings: BridgeWarning[] = [];
    toBedrockToolConfig([evil], { onWarning: (w) => warnings.push(w) });
    assert.ok(warnings.length >= 2);
    for (const warning of warnings) assert.ok(!warning.message.includes("\n"), warning.message);
    assert.ok(warnings[0]?.message.startsWith(String.raw`"evil\nFAKE LOG LINE" "/properties/p\nINJECTED": `), warnings[0]?.message);
    assert.throws(
      () => toBedrockToolConfig([evil], { onUnsafeSchema: "throw" }),
      (error: unknown) =>
        error instanceof UnsafeSchemaError &&
        error.message.split("\n").length === 2 &&
        error.message.includes(String.raw`"evil\nFAKE LOG LINE" "/properties/p\nINJECTED"`),
    );
  });

  it("doesn't hang on a circular schema", () => {
    const node: Record<string, unknown> = { type: "array" };
    node.items = node;
    const { schema, warnings } = convert({ type: "object", properties: { loop: node } });
    assert.equal(schema, undefined);
    assert.ok(warnings.some((w) => w.code === "schema-too-deep"));
  });
});
