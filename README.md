# mcp-bedrock-bridge

Use [MCP](https://modelcontextprotocol.io) server tools with the [Amazon Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) without the silent failures. Three small, dependency-free functions:

- `toBedrockToolConfig(tools)`: MCP `tools/list` result → Converse `toolConfig` with Nova-safe input schemas and Bedrock-valid tool names.
- `toMcpToolCall(toolUse, toolNames)`: Bedrock `toolUse` → MCP `tools/call` params (original name and arguments).
- `toBedrockToolResult(toolUseId, result)`: MCP `CallToolResult` → a valid Converse `toolResult` block that never mixes `text` and `json`.

## Why

I built [Duly](https://github.com/devcaos/duly), an MCP server with an Amazon Nova 2 Lite agent on top, and hit problems that no error message pointed to ([Duly's friction log](https://github.com/devcaos/duly/blob/main/FRICTION.md)):

- **A tool result that mixes `text` and `json` blocks makes Bedrock drop the tools from the prompt.** There is no `ValidationException`. Nova just answers in text, even with `toolChoice: { any: {} }`, and `usage.inputTokens` drops sharply (in Duly from about 2,400 to 419), a sign that the tool definitions are no longer in the prompt. In Duly, only the first question of each conversation worked. `npm run test:bedrock` reproduces it (see [Verified behaviour](#verified-behaviour)).
- **MCP schemas aren't Nova schemas.** JSON Schema generated from zod carries `$schema`, `additionalProperties`, formats and patterns. The Nova (v1) docs say the root may only have `type`, `properties` and `required`.
- **MCP tool names aren't Bedrock tool names.** MCP allows dots and up to 128 characters (`admin.tools.list`). Bedrock allows `[a-zA-Z0-9_-]`, 1–64 characters.

This library packages the fixes, so you don't have to rediscover them.

## Install

Not published to npm. Install from GitHub; npm runs the `prepare` script, which builds `dist/`:

```sh
npm install github:devcaos/mcp-bedrock-bridge @aws-sdk/client-bedrock-runtime
```

- npm 11 may print an `install-scripts` warning about `prepare`. With npm 11.19.0 the build still ran when npm packed the git dependency, and `npm install-scripts ls` listed nothing to review.
- `@aws-sdk/client-bedrock-runtime` is a peer dependency (`>=3.1152.0 <4`), used only for types. Tested with 3.1152.0.
- There are no runtime dependencies. The MCP SDK isn't required: the input types are structural, so results from `@modelcontextprotocol/sdk` (v1, tested with 1.32.1) fit without a cast. The v2 packages (`@modelcontextprotocol/client`) should fit too, but that is **unverified**.
- ESM only (`import`, not `require`).

### Node.js versions

| Use | Minimum | Why |
|---|---|---|
| The built package (runtime) | **Node.js 20** | Plain ES2022 plus `atob`, with no Node APIs, so it should also run in browsers, Deno, Bun and edge runtimes. Only Node.js 24 has been tested. |
| Development: `npm test`, `npm run test:bedrock` | **Node.js 22.18.0** | The tests and scripts are `.ts` files that Node runs directly. Node strips TypeScript types without a flag since v22.18.0 and v23.6.0 ([Node.js docs, Modules: TypeScript](https://nodejs.org/api/typescript.html)). Tested with v24.20.0. |

## Usage

The same code is in [`examples/basic.ts`](examples/basic.ts), which is type-checked with the rest of the repo.

```ts
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Message } from "@aws-sdk/client-bedrock-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toBedrockToolConfig, toBedrockToolResult, toMcpToolCall } from "mcp-bedrock-bridge";

const mcp = new Client({ name: "my-agent", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL("https://example.com/mcp")));

// MCP tools -> Bedrock toolConfig (Nova-safe schemas, Bedrock-valid names).
const { toolConfig, toolNames } = toBedrockToolConfig(await mcp.listTools());

const bedrock = new BedrockRuntimeClient({ region: "eu-west-1" });
const messages: Message[] = [{ role: "user", content: [{ text: "Is my dishwasher still under warranty?" }] }];

for (let turn = 0; turn < 5; turn++) {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: "eu.amazon.nova-2-lite-v1:0",
      messages,
      toolConfig,
      inferenceConfig: { temperature: 0 },
    }),
  );
  const message = response.output?.message;
  if (!message) break;
  messages.push(message);

  const toolUses = (message.content ?? []).flatMap((block) => (block.toolUse ? [block.toolUse] : []));
  if (toolUses.length === 0) {
    console.log(message.content?.map((block) => block.text ?? "").join(""));
    break;
  }

  // Bedrock toolUse -> MCP tools/call -> Bedrock toolResult (never text + json mixed).
  const results = [];
  for (const toolUse of toolUses) {
    const result = await mcp.callTool(toMcpToolCall(toolUse, toolNames));
    results.push(toBedrockToolResult(toolUse.toolUseId!, result));
  }
  messages.push({ role: "user", content: results });
}

await mcp.close();
```

In a real agent, catch `UnknownToolError` from `toMcpToolCall` and answer that toolUse with an error result. Don't forward the name to the server.

`listTools()` returns one page. If the server paginates (the result has a `nextCursor`), call it again with `{ cursor: nextCursor }` until there is no cursor, and pass all the tools to `toBedrockToolConfig`.

## API

### `toBedrockToolConfig(tools, options?)`

`tools` is an MCP `tools/list` result (`{ tools }`) or its `tools` array. Returns:

| Field | Type | |
|---|---|---|
| `toolConfig` | `ToolConfiguration` | Pass it to `ConverseCommand`. Add `toolChoice` yourself if you need one. |
| `toolNames` | `ToolNameMap` | Maps MCP names to Bedrock names and back. Needed by `toMcpToolCall`. |
| `warnings` | `BridgeWarning[]` | Everything that was changed or left out. Warnings also go to `onWarning`. |

Options:

| Option | Default | |
|---|---|---|
| `onUnsafeSchema` | `"warn"` | What to do with schemas that aren't Nova-safe. See [Unsafe schemas](#unsafe-schemas). |
| `maxSchemaDepth` | `32` | Maximum JSON nesting depth of an `inputSchema`, an integer from 1 to 256 (otherwise `TypeError`). A deeper or circular schema is unsafe and is never sent. |
| `onWarning` | `console.warn` | Called for each warning. `() => {}` silences them. |

Each tool's `description` falls back to its `title`, then its `name`, because Bedrock requires a non-empty description when one is sent. A tool without a name, or a second tool with the same name, is skipped with a warning. If no tools are left, you get a `no-tools` warning: in that case don't send the empty `toolConfig`. If `tools` is neither an array nor an object with a `tools` array, it throws `TypeError`.

Warning codes (`BridgeWarning.code`):

| Code | Meaning |
|---|---|
| `nested-schema` | A nested object (or array of objects) was kept, made safe. |
| `untyped-schema` | A property with no type (`{}`, only a `description`, or `true`) was kept without a `type`. |
| `map-schema` | `additionalProperties` was dropped from an object with no `properties` (a map, such as zod's `z.record`). |
| `unsupported-schema` | A part that can't be converted, or a root-level problem. |
| `schema-too-deep` | The schema is deeper than `maxSchemaDepth`, or circular. |
| `tool-excluded` | The tool was left out of the `toolConfig`. |
| `invalid-tool`, `duplicate-tool` | A tool without a name, or a second tool with the same name, was skipped. |
| `no-tools` | No tools are left. |
| `content-omitted` | Tool result content was replaced by a marker or left out. |
| `invalid-result` | The MCP result isn't an object, so it was sent as an empty result. |

### `toMcpToolCall(toolUse, toolNames)`

Returns `{ name, arguments }` for `client.callTool(...)`, using the original MCP name. Throws:

- `UnknownToolError` if the model named a tool that isn't in `toolNames`. The original MCP name of an aliased tool counts as unknown too: only the names that were sent to Bedrock are accepted.
- `TypeError` if `toolUse.input` isn't an object. A missing input becomes `{}`.

It doesn't validate the arguments against the schema. The MCP server does that, and returns an `isError` result that you can send back to the model.

### `toBedrockToolResult(toolUseId, result, options?)`

Returns `{ toolResult: { toolUseId, content, status } }`, a Converse `ContentBlock` that is ready for `messages.push({ role: "user", content: [block] })`. Throws `TypeError` if `toolUseId` doesn't match Bedrock's pattern, or if an option is invalid (see below).

| MCP result | Bedrock `content` |
|---|---|
| `structuredContent` (any JSON value) | **One `json` block.** An object is sent as is. Any other value (array, string, number, null) is wrapped as `{ result: value }`. The text depends on `textMode`, below. |
| Text only | **One `text` block**, with the text items joined by a blank line. Whitespace-only text items count as no text. |
| Text and/or images, no `structuredContent` | One `text` block, then one `image` block per image (png, jpeg, gif, webp). |
| No content at all | One `text` block: `"(no content)"` (`emptyText`). |
| Not an object | Like no content, with an `invalid-result` warning. |
| `isError: true` | `status: "error"`, otherwise `"success"`. |

`textMode` sets what happens to the text of a result that also has `structuredContent`. The MCP spec asks servers to also send the JSON as text, but in practice the text is often a sentence for humans.

| `textMode` | Text items |
|---|---|
| `"auto"` (default) | Dropped if the text is only the JSON serialization of `structuredContent`. The check parses the text and compares it deeply, so key order and whitespace don't matter. Any other text is kept: `{ result: structuredContent, text }`. |
| `"always"` | Always kept: `{ result: structuredContent, text }`. |
| `"never"` | Always dropped. |

Other options: `includeStatus` (default `true`; set it to `false` for models that don't support `status`), `emptyText` (must not be blank), `maxJsonDepth` (default `32`, an integer from 1 to 256, used by the `"auto"` comparison) and `onWarning`. An invalid `emptyText` or `maxJsonDepth` throws `TypeError`.

Content that Bedrock can't take is replaced by a short text marker, with a warning, so the model knows something was there:

| MCP content | Becomes |
|---|---|
| `image` with an unsupported type, or empty or invalid base64 | `[image omitted: image/svg+xml]` |
| `audio` | `[audio omitted: audio/wav]` (tool results have no audio block) |
| `resource_link` | `[resource link: name (uri, mimeType)]` |
| `resource` with `text` | `[resource uri]` followed by the text |
| `resource` with an image `blob` | an `image` block |
| `resource` with another `blob`, or an empty image `blob` | `[resource omitted: uri (mimeType)]` |
| Unknown content type | `[content omitted: type]` |
| Images in a result with `structuredContent` | Left out, with a warning (only one `json` block is allowed) |

The library doesn't produce Bedrock `document`, `video` or `searchResult` blocks. Text always comes before images, so the original order of mixed text and images is lost.

### Other exports

- `ToolNameMap`: `toBedrock(mcpName)`, `toMcp(bedrockName)`, `entries()`, `size`.
- `isValidBedrockToolName(name)`
- `UnsafeSchemaError` (with `issues: { tool, path, reason }[]`) and `UnknownToolError` (with `toolName`).
- Types: `McpTool`, `McpCallToolResult`, `McpToolCall`, `BridgeWarning`, `BridgeWarningCode`, and the options types.

## Nova-safe rules

Every rule says where it comes from. Docs were checked on 2026-10-18. "test:bedrock" means `npm run test:bedrock` with `eu.amazon.nova-2-lite-v1:0` in `eu-west-1` on 2026-10-18 (see [Verified behaviour](#verified-behaviour)).

| # | Rule | Source |
|---|---|---|
| 1 | Tool names match `[a-zA-Z0-9_-]+`, 1–64 characters. | [Bedrock API: ToolSpecification](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolSpecification.html) |
| 2 | A tool description, if sent, has at least 1 character. | [Bedrock API: ToolSpecification](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolSpecification.html) |
| 3 | The root schema is `type: "object"` and has only `type`, `properties` and `required`. | [Nova User Guide: Defining a tool](https://docs.aws.amazon.com/nova/latest/userguide/tool-use-definition.html). This page is about Nova (v1) understanding models; the [Nova 2 tool page](https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-tools.html) doesn't repeat the rule. test:bedrock passes with schemas that follow it. |
| 4 | Every object has a `required` array, `[]` when all fields are optional. | **Library convention** taken from Duly. The Nova 2 docs only say to "denote required vs. optional parameters using JSON schema notation". Not documented as mandatory. |
| 5 | Properties keep only `type`, `description`, `enum`, `items` (plus `properties`/`required` for nested objects); `const` becomes `enum`; nullable types collapse to the non-null type, and `null` is removed from their `enum`. | **Library convention** taken from Duly, conservative on purpose. The Nova 2 docs example uses `minimum`/`maximum` and `["number", "null"]`, so Nova 2 probably accepts more. Dropped keywords are **unverified** as harmful. |
| 6 | Keep nesting shallow: "Limit JSON schemas to two layers of nesting for best performance". | [Nova 2 User Guide: Using tools](https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-tools.html). test:bedrock: a schema with one nested object was accepted, and the model filled it correctly. |
| 7 | A `toolResult` is either a single `json` block or text and images, never `text` + `json`. | [Nova User Guide: Returning tool results](https://docs.aws.amazon.com/nova/latest/userguide/tool-use-results.html): "should be either a single JSON or a mix of text and images". The [Nova 2 page](https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-tools.html) shows a single `json` block but doesn't state the rule. **test:bedrock reproduces the failure on Nova 2 Lite** (see below). |
| 8 | Text + image tool results are accepted. | Nova (v1) docs above. test:bedrock: accepted on Nova 2 Lite, and the model described the image correctly. |
| 9 | `toolResult.status` is `success` or `error`, and is "only supported by Amazon Nova and Anthropic Claude 3 and 4 models"; image tool results have the same limit. | [Bedrock API: ToolResultBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultBlock.html), [ToolResultContentBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultContentBlock.html) |
| 10 | `toolUseId` matches `[a-zA-Z0-9_.:-]+`, 1–64 characters. | [Bedrock API: ToolResultBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultBlock.html) |
| 11 | Image formats: png, jpeg, gif, webp, sent as bytes. | [Bedrock API: ImageBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ImageBlock.html) |
| 12 | Use `temperature: 0` for tool calling. | [Nova User Guide: Defining a tool](https://docs.aws.amazon.com/nova/latest/userguide/tool-use-definition.html) (a recommendation, not enforced by this library) |

**Unverified:**

- Whether Bedrock accepts an empty `toolResult.content` array. The library always sends at least one block, so it never relies on it.
- Whether Nova accepts `$ref`, `anyOf`, `oneOf`, `allOf` or `not` in tool schemas. The library treats them as unsafe.
- Whether Bedrock accepts properties without a `type` in general. No AWS doc says. test:bedrock: Nova 2 Lite accepted one in a single run (see [Verified behaviour](#verified-behaviour)).
- Behaviour on any model other than Nova 2 Lite.

### Unsafe schemas

A schema is unsafe when it has any of these (warning code in brackets):

- A nested object: an `object` property, or an array of objects (`nested-schema`).
- An untyped property: `{}`, a property with only a `description`, or `true`, as zod's `z.any()` produces (`untyped-schema`). It is sent without a `type`. **Accepting untyped properties is unverified against Bedrock**: no AWS doc says whether a property needs a `type`. test:bedrock: Nova 2 Lite accepted one in a single run.
- A map: an object with `additionalProperties` and no `properties`, as zod's `z.record` produces (`map-schema`). `additionalProperties` isn't sent, so the model sees an object with no keys.
- A part that can't be converted: `$ref`, `anyOf`/`oneOf`/`allOf`/`not` other than a nullable pair, union types, tuple `items` (`unsupported-schema`).
- A root-level problem: an `inputSchema` or root that isn't an object, `$ref` or a combinator at the root, or `properties` that isn't an object (`unsupported-schema`).
- More than `maxSchemaDepth` levels of nesting, or a cycle (`schema-too-deep`).

| `onUnsafeSchema` | Nested objects, untyped properties, maps | Parts that can't be converted | Root-level problems, too deep or circular |
|---|---|---|---|
| `"warn"` (default) | Kept and made safe recursively, with a warning. | The tool is left out of the `toolConfig`, with `unsupported-schema` and `tool-excluded` warnings. | The tool is left out. |
| `"throw"` | `UnsafeSchemaError` | `UnsafeSchemaError` | `UnsafeSchemaError` |
| `"passthrough"` | Kept and made safe, with a warning. | Sent unchanged, with a warning. Root keys other than `type`/`properties`/`required` are still removed. | The tool is left out, with a `tool-excluded` warning: nothing usable is left to send. |

The default is `"warn"` because many real MCP servers have nested objects, Nova only advises against deep nesting "for best performance", and test:bedrock showed one level working. The library drops a tool rather than send a schema it can't vouch for, because a request that Bedrock rejects breaks the whole conversation, not just one tool.

### Tool names

A name that is already valid is kept. Otherwise each invalid character becomes `_` (`admin.tools.list` → `admin_tools_list`). If the result is longer than 64 characters, or another tool already has it, the name is cut and gets an 8-character FNV-1a hash suffix. Valid names are reserved first, so an alias never takes a real tool's name. Aliases are assigned in sorted name order, so they don't depend on the order the server lists its tools in. Adding or removing a tool can still change the alias of another tool whose name collides with it after sanitizing, so use the `toolNames` from the same `toBedrockToolConfig` call that built the `toolConfig` the model saw.

## Verified behaviour

`npm run test:bedrock` runs an MCP server in-process (official SDK v1, `InMemoryTransport`) and talks to real Bedrock. These are the results from four runs on 2026-10-18, `eu.amazon.nova-2-lite-v1:0`, `eu-west-1`, `temperature: 0`, with the same numbers all four times (probe D was only in the fourth run):

| Check | Result |
|---|---|
| The model calls `orders.get_status`, sent as `orders_get_status`, and `toMcpToolCall` maps it back with `order_id: "A-1"`. | PASS |
| The final answer names the carrier "Zephyr Freight", which is only in the `structuredContent` of the library's `{ result, text }` json block. | PASS |
| A second question ("And order B-7?") after that tool result gets a new `toolUse` with `order_id: "B-7"`. | PASS |
| The tools are still in the prompt: `inputTokens` grows from 1,026 (call 1) to 1,170 (call 3). | PASS |
| **Negative control:** same history, but the tool result is `[text, json]`. | Reproduced: `inputTokens` **1,170 → 90**, `stopReason: end_turn`, no `toolUse` with `toolChoice` auto **or `any`**. The model wrote the arguments as text (`{"order_id":"B-7"}`) and then said it couldn't find the order. No error from Bedrock. |
| Probe: text + 64×64 PNG in one tool result. | Accepted. The model said the swatch is red, which is correct. |
| Probe: a tool with one nested object (`address`). | Accepted. The model filled `address.street`, `city` and `postcode`. |
| Probe D: a tool with an untyped property (`payload` with only a description). | Accepted, with an `untyped-schema` warning. The model sent `payload: {"plan":"pro","seats":3}`. |

This was one model, one region and one day. Bedrock's behaviour may change.

## Limitations

- **Tool descriptions, schemas and results are untrusted input.** They come from the MCP server, and they reach the model. The library makes them structurally safe: own properties only, no prototype pollution, depth limits, Map lookups for untrusted keys, and server strings quoted in warnings and errors. It does **not** protect against prompt injection in descriptions or results. Only connect servers you trust, and keep a human in the loop for actions that matter.
- No `$ref`/`$defs` inlining. Tools that use them are left out under `"warn"`. Schema generators such as zod can emit `$ref` for recursive schemas.
- Validation keywords (`pattern`, `format`, `minLength`, `minimum`...) aren't sent to the model, so it may produce values the server rejects. The server's `isError` result then goes back with `status: "error"`, so the model can correct itself.
- Images in a result that has `structuredContent` are dropped. Audio and non-image binary resources become text markers.
- No retries or `toolChoice` strategy. While building Duly, Nova 2 Lite sometimes answered in text instead of calling a tool, so Duly retries once with `toolChoice: { any: {} }`.
- Tested only with Amazon Nova 2 Lite. `status` and image results are documented for Nova and Claude 3/4 only.
- `toBedrockToolConfig` converts the tools you pass it. It doesn't follow `tools/list` pagination (`nextCursor`): collect every page first.
- Schemas built in the same process can share objects (a DAG). The depth limit still applies, but a wide schema that reuses the same sub-schema many times can take seconds to walk. Schemas that arrive as JSON can't share objects.
- No size or count limit on images in tool results: every valid image is sent as it is. Bedrock's image size and count limits for tool results are **unverified** here.
- Warnings go to `console.warn` by default.

## Development

```sh
npm install
npm run build        # tsc -> dist/
npm run lint         # ESLint + tsc --noEmit (src, test, scripts, examples)
npm test             # unit tests (node:test, no AWS)
npm run test:bedrock # real Converse calls (needs AWS credentials)
```

`npm run test:bedrock` reads the standard AWS SDK variables from `.env.local`, which is gitignored (see [`.env.example`](.env.example)):

| Variable | |
|---|---|
| `AWS_REGION` | e.g. `eu-west-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Or use `AWS_PROFILE` instead. |
| `AWS_SESSION_TOKEN` | Only for temporary credentials. |
| `BEDROCK_MODEL_ID` | Optional. Default `eu.amazon.nova-2-lite-v1:0`. |

The script prints only the region and the model id, never credentials. The account needs Bedrock access to the model.

## License

[MIT](LICENSE)
