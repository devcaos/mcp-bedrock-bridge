import { isPlainObject, jsonDepth, own } from "./runtime.ts";

// Turns an MCP tool inputSchema into one that Amazon Nova accepts:
// - root: only `type: "object"`, `properties` and `required` (Nova docs, "Defining a tool");
// - properties: only `type`, `description`, `enum` and `items` (plus `properties`/`required` for
//   nested objects), the same subset Duly sends to Nova 2 Lite;
// - every object gets a `required` array, empty when all its fields are optional.
// Validation keywords (pattern, minLength, format...) are dropped: the MCP server still validates
// the arguments against its full schema.
// A problem at the root ($ref, anyOf, a non-object root...) leaves nothing usable to send, so it
// excludes the tool under every policy, like a schema that is too deep.
// The input comes from an MCP server and is untrusted: only own properties are read, and every
// object built from its keys goes through Object.fromEntries, so a property named "__proto__"
// stays a plain key and never changes a prototype.

export type UnsafeSchemaPolicy = "warn" | "throw" | "passthrough";

export type SchemaProblemCode = "nested-schema" | "untyped-schema" | "map-schema" | "unsupported-schema" | "schema-too-deep";

export interface SchemaProblem {
  code: SchemaProblemCode;
  path: string;
  reason: string;
  /**
   * false: the schema was made safe, but Nova may handle it worse (nested object, untyped
   * property, dropped additionalProperties).
   * true: a part couldn't be converted ($ref, anyOf, union types...).
   */
  fatal: boolean;
  /** The schema can't be sent at all (a root-level problem, too deep or circular). */
  excludesTool?: boolean;
}

export interface SanitizedSchema {
  schema: Record<string, unknown>;
  problems: SchemaProblem[];
}

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
const COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

interface Context {
  problems: SchemaProblem[];
  passthrough: boolean;
}

export function sanitizeInputSchema(
  input: unknown,
  options: { maxDepth: number; passthrough: boolean },
): SanitizedSchema {
  const problems: SchemaProblem[] = [];
  const empty = { type: "object", properties: {}, required: [] };
  if (input === undefined) return { schema: empty, problems };
  const rootProblem = (path: string, reason: string) =>
    problems.push({ code: "unsupported-schema", path, reason, fatal: true, excludesTool: true });
  if (!isPlainObject(input)) {
    rootProblem("", "inputSchema is not an object");
    return { schema: empty, problems };
  }
  if (jsonDepth(input, options.maxDepth) === Infinity) {
    problems.push({
      code: "schema-too-deep",
      path: "",
      reason: `inputSchema is nested deeper than ${options.maxDepth} levels (or is circular)`,
      fatal: true,
      excludesTool: true,
    });
    return { schema: empty, problems };
  }

  const ctx: Context = { problems, passthrough: options.passthrough };
  const type = own(input, "type");
  if (type !== undefined && type !== "object") rootProblem("/type", `root type must be "object", got ${describe(type)}`);
  for (const key of ["$ref", ...COMBINATORS]) {
    if (own(input, key) !== undefined) rootProblem(`/${key}`, `${key} at the root is not supported`);
  }
  const { properties, required } = sanitizeObjectMembers(input, "", ctx);
  return { schema: { type: "object", properties, required }, problems };
}

function sanitizeObjectMembers(
  node: Record<string, unknown>,
  path: string,
  ctx: Context,
): { properties: Record<string, unknown>; required: string[] } {
  const rawProperties = own(node, "properties");
  let properties: Record<string, unknown> = {};
  if (isPlainObject(rawProperties)) {
    properties = Object.fromEntries(
      Object.entries(rawProperties).map(([name, field]) => [
        name,
        sanitizeProperty(field, `${path}/properties/${escapePointer(name)}`, ctx),
      ]),
    );
  } else if (rawProperties !== undefined) {
    ctx.problems.push({
      code: "unsupported-schema",
      path: `${path}/properties`,
      reason: "properties is not an object",
      fatal: true,
      excludesTool: path === "",
    });
  }
  // A map (zod's z.record) only has additionalProperties, which isn't sent: the model would see
  // an object that takes no keys.
  const additional = own(node, "additionalProperties");
  if (additional !== undefined && additional !== false && Object.keys(properties).length === 0) {
    ctx.problems.push({
      code: "map-schema",
      path: `${path}/additionalProperties`,
      reason: "additionalProperties is dropped and the object has no properties, so the model sees an object with no keys",
      fatal: false,
    });
  }
  const rawRequired = own(node, "required");
  const required = Array.isArray(rawRequired)
    ? [...new Set(rawRequired.filter((name): name is string => typeof name === "string" && Object.hasOwn(properties, name)))]
    : [];
  return { properties, required };
}

function sanitizeProperty(node: unknown, path: string, ctx: Context): unknown {
  if (node === true) {
    ctx.problems.push({ code: "untyped-schema", path, reason: "schema `true` (any value) has no type", fatal: false });
    return {};
  }
  if (!isPlainObject(node)) {
    ctx.problems.push({ code: "unsupported-schema", path, reason: `schema is ${describe(node)}, not an object`, fatal: true });
    return ctx.passthrough ? node : {};
  }

  // `anyOf: [X, { type: "null" }]` (how zod and others write nullable fields) becomes X.
  const nullable = unwrapNullable(node);
  if (nullable) {
    const inner = sanitizeProperty(nullable, path, ctx);
    const description = own(node, "description");
    if (isPlainObject(inner) && typeof description === "string" && own(inner, "description") === undefined) {
      return Object.fromEntries([...Object.entries(inner), ["description", description]]);
    }
    return inner;
  }

  const unsupported = ["$ref", ...COMBINATORS].filter((key) => own(node, key) !== undefined);
  if (unsupported.length > 0) {
    ctx.problems.push({ code: "unsupported-schema", path, reason: `${unsupported.join(", ")} is not supported`, fatal: true });
    return ctx.passthrough ? node : {};
  }

  const entries: [string, unknown][] = [];
  const type = normalizeType(node, path, ctx);
  if (type !== undefined) entries.push(["type", type]);

  const description = own(node, "description");
  if (typeof description === "string") entries.push(["description", description]);

  const enumValues = own(node, "enum");
  const constValue = own(node, "const");
  let values = Array.isArray(enumValues) ? [...enumValues] : constValue !== undefined ? [constValue] : undefined;
  // With a single non-null type (a nullable type collapses to one), null is no longer a valid value.
  if (values && typeof type === "string" && type !== "null") values = values.filter((value) => value !== null);
  if (values && values.length > 0) entries.push(["enum", values]);

  if (type === "object") {
    ctx.problems.push({ code: "nested-schema", path, reason: "nested object", fatal: false });
    const { properties, required } = sanitizeObjectMembers(node, path, ctx);
    entries.push(["properties", properties], ["required", required]);
  } else if (type === "array") {
    const items = own(node, "items");
    if (isPlainObject(items) || items === true) {
      entries.push(["items", sanitizeProperty(items, `${path}/items`, ctx)]);
    } else if (items !== undefined) {
      ctx.problems.push({ code: "unsupported-schema", path: `${path}/items`, reason: "tuple or invalid items is not supported", fatal: true });
      if (ctx.passthrough) entries.push(["items", items]);
    }
  }
  return Object.fromEntries(entries);
}

// The non-null branch of `anyOf`/`oneOf: [X, { type: "null" }]`, if the node is exactly that.
function unwrapNullable(node: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ["anyOf", "oneOf"]) {
    const branches = own(node, key);
    if (!Array.isArray(branches) || branches.length !== 2) continue;
    const others = Object.keys(node).filter((k) => k !== key && k !== "description" && k !== "title");
    if (others.length > 0) continue;
    const isNull = (b: unknown) => isPlainObject(b) && own(b, "type") === "null" && Object.keys(b).length === 1;
    const [a, b] = branches as unknown[];
    if (isNull(a) && isPlainObject(b)) return b;
    if (isNull(b) && isPlainObject(a)) return a;
  }
  return undefined;
}

// A single JSON type. `["string", "null"]` becomes "string"; a missing type is inferred from
// properties/items/enum when possible.
function normalizeType(node: Record<string, unknown>, path: string, ctx: Context): unknown {
  let type = own(node, "type");
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    if (nonNull.length === 1) type = nonNull[0];
    else if (nonNull.length === 0) type = "null";
    else {
      ctx.problems.push({ code: "unsupported-schema", path: `${path}/type`, reason: `union type ${describe(type)} is not supported`, fatal: true });
      return ctx.passthrough ? type : undefined;
    }
  }
  if (type === undefined) {
    if (own(node, "properties") !== undefined) return "object";
    if (own(node, "items") !== undefined) return "array";
    const values = own(node, "enum") ?? (own(node, "const") !== undefined ? [own(node, "const")] : undefined);
    if (Array.isArray(values) && values.length > 0) {
      const kinds = new Set(values.map((v) => (Number.isInteger(v) ? "integer" : typeof v)));
      const [kind] = kinds;
      if (kinds.size === 1 && (kind === "string" || kind === "boolean" || kind === "integer" || kind === "number")) return kind;
    }
    ctx.problems.push({ code: "untyped-schema", path, reason: "no type (any value)", fatal: false });
    return undefined;
  }
  if (typeof type !== "string" || !JSON_TYPES.has(type)) {
    ctx.problems.push({ code: "unsupported-schema", path: `${path}/type`, reason: `unknown type ${describe(type)}`, fatal: true });
    return ctx.passthrough ? type : undefined;
  }
  return type;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

// A short, log-safe description of a schema value.
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value) || typeof value === "string") return (JSON.stringify(value) ?? "").slice(0, 60);
  return typeof value === "object" ? "an object" : String(value);
}
