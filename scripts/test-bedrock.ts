// Real Bedrock check: an in-process MCP server, the library's conversions, and Converse calls to
// Amazon Nova 2 Lite. Run with `npm run test:bedrock` (reads .env.local through Node's
// --env-file-if-exists; never prints credentials, only the region and model id).
//
// Checks (they decide the exit code):
//   1. The model calls the MCP tool sent through toBedrockToolConfig (dotted name -> alias).
//   2. Its final answer uses a value that only exists in the toolResult built by toBedrockToolResult.
//   3. A second question that needs a tool, after that toolResult, still gets a tool call, and the
//      tools are still in the prompt (inputTokens grows instead of falling).
// Probes (informative, they never fail the run):
//   A. Negative control: the same history with a toolResult that mixes text and json.
//   B. A toolResult with text + a PNG image.
//   C. A tool whose schema has a nested object (kept by the default "warn" policy).
//   D. A tool whose schema has an untyped property (kept by the default "warn" policy).

import { existsSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ContentBlock, ConverseCommandOutput, Message, ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toBedrockToolConfig, toBedrockToolResult, toMcpToolCall } from "../src/index.ts";
import type { BridgeWarning, McpCallToolResult, ToolNameMap } from "../src/index.ts";

const MODEL_ID = process.env.BEDROCK_MODEL_ID || "eu.amazon.nova-2-lite-v1:0";
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const SYSTEM = [
  {
    text: "You are an order support assistant. Always look orders up with the tools; never guess order details. Answer in one or two sentences.",
  },
];

// Values the model can't guess: they only reach it through the tool result.
const ORDERS: Record<string, { order_id: string; status: string; carrier: string; eta: string }> = {
  "A-1": { order_id: "A-1", status: "shipped", carrier: "Zephyr Freight", eta: "2026-10-21" },
  "B-7": { order_id: "B-7", status: "held at customs", carrier: "Quillon Express", eta: "2026-11-03" },
};

interface CallRecord {
  step: string;
  stopReason?: string;
  inputTokens?: number;
  toolUse?: string;
  error?: string;
}
interface CheckRecord {
  check: string;
  result: "PASS" | "FAIL" | "INFO";
  details: string;
}

const calls: CallRecord[] = [];
const checks: CheckRecord[] = [];
const bedrock = new BedrockRuntimeClient({ region: REGION });

async function main() {
  console.log(`Model: ${MODEL_ID}, region: ${REGION ?? "(not set)"}, .env.local: ${existsSync(".env.local") ? "found" : "not found"}`);
  if (!REGION) throw new Error("Set AWS_REGION (for example in .env.local).");

  const mcp = await startMcpServer();
  const listed = await mcp.listTools();
  const warnings: BridgeWarning[] = [];
  const { toolConfig, toolNames } = toBedrockToolConfig(listed, { onWarning: (w) => warnings.push(w) });
  console.log(`MCP tools: ${[...toolNames.entries()].map(([m, b]) => (m === b ? m : `${m} -> ${b}`)).join(", ")}`);
  if (warnings.length > 0) console.log(`Warnings: ${warnings.map((w) => w.message).join(" | ")}`);

  // 1. First question: the model should call orders.get_status (sent as orders_get_status).
  const messages: Message[] = [{ role: "user", content: [{ text: "What's the status of order A-1, and which carrier has it?" }] }];
  const first = await converse("1. first question", messages, toolConfig);
  const firstUse = toolUseOf(first);
  let call1Ok = false;
  let toolResultBlock: ContentBlock.ToolResultMember | undefined;
  let rawResult: McpCallToolResult | undefined;
  if (firstUse) {
    const call = toMcpToolCall(firstUse, toolNames);
    call1Ok = call.name === "orders.get_status" && call.arguments.order_id === "A-1";
    rawResult = (await mcp.callTool(call)) as McpCallToolResult;
    toolResultBlock = toBedrockToolResult(firstUse.toolUseId ?? "", rawResult);
  }
  record("toolUse for the converted MCP tool", call1Ok, firstUse ? `${firstUse.name} ${JSON.stringify(firstUse.input)}` : "no toolUse");
  if (!first?.output?.message || !firstUse || !toolResultBlock || !rawResult) return finish(mcp);

  // 2. Send the library's toolResult back: the answer must use the carrier from the result.
  messages.push(first.output.message, { role: "user", content: [toolResultBlock] });
  const second = await converse("2. after toolResult", messages, toolConfig);
  const answer = textOf(second);
  record("final answer uses the toolResult", /zephyr/i.test(answer), JSON.stringify(answer.slice(0, 160)));
  if (!second?.output?.message) return finish(mcp);

  // 3. A second question that needs the tool again, with the toolResult in the history.
  messages.push(second.output.message, { role: "user", content: [{ text: "And order B-7?" }] });
  const third = await converse("3. second question", messages, toolConfig);
  const thirdUse = toolUseOf(third);
  const thirdCall = thirdUse ? safeToolCall(thirdUse, toolNames) : undefined;
  record(
    "second question still calls the tool",
    thirdCall?.name === "orders.get_status" && thirdCall.arguments.order_id === "B-7",
    thirdUse ? `${thirdUse.name} ${JSON.stringify(thirdUse.input)}` : `no toolUse (${third?.stopReason})`,
  );
  const tokens1 = first.usage?.inputTokens ?? 0;
  const tokens3 = third?.usage?.inputTokens ?? 0;
  record("tools still in the prompt (inputTokens)", tokens3 > tokens1, `call 1: ${tokens1}, call 3: ${tokens3}`);

  // A. Negative control: the same history, but the toolResult mixes text and json.
  const structured = rawResult.structuredContent;
  const mixedText = rawResult.content?.find((c) => c.type === "text")?.text;
  const mixed: Message[] = messages.map((message) =>
    message.content?.some((block) => block.toolResult)
      ? {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: firstUse.toolUseId,
                content: [{ text: String(mixedText) }, { json: structured as never }],
                status: "success",
              },
            },
          ],
        }
      : message,
  );
  for (const [label, choice] of [
    ["auto", undefined],
    ["any", { any: {} }],
  ] as const) {
    const response = await converse(`A. mixed text+json, toolChoice ${label}`, mixed, { ...toolConfig, toolChoice: choice });
    const use = toolUseOf(response);
    checks.push({
      check: `negative control (toolChoice ${label})`,
      result: "INFO",
      details: response
        ? `stopReason ${response.stopReason}, toolUse: ${use ? use.name : "none"}, inputTokens ${response.usage?.inputTokens} (library result: ${tokens3}), answer ${JSON.stringify(textOf(response).slice(0, 100))}`
        : `request failed: ${calls.at(-1)?.error}`,
    });
  }

  // B. text + image in one toolResult (forced call to render_swatch).
  const swatchTool = toolNames.toBedrock("render_swatch") ?? "render_swatch";
  const imageMessages: Message[] = [{ role: "user", content: [{ text: "Render the swatch for SKU-9 and tell me what color it is." }] }];
  const swatch = await converse("B. swatch call", imageMessages, { ...toolConfig, toolChoice: { tool: { name: swatchTool } } });
  const swatchUse = toolUseOf(swatch);
  if (swatch?.output?.message && swatchUse) {
    const result = (await mcp.callTool(toMcpToolCall(swatchUse, toolNames))) as McpCallToolResult;
    const block = toBedrockToolResult(swatchUse.toolUseId ?? "", result);
    const kinds = (block.toolResult.content ?? []).map((c) => Object.keys(c)[0]).join(" + ");
    imageMessages.push(swatch.output.message, { role: "user", content: [block] });
    const described = await converse("B. after text+image toolResult", imageMessages, toolConfig);
    const text = textOf(described);
    checks.push({
      check: "text + image toolResult",
      result: "INFO",
      details: described
        ? `accepted (${kinds}), stopReason ${described.stopReason}, mentions red: ${/\bred\b/i.test(text)}, answer ${JSON.stringify(text.slice(0, 120))}`
        : `rejected (${kinds}): ${calls.at(-1)?.error}`,
    });
  } else {
    checks.push({ check: "text + image toolResult", result: "INFO", details: "skipped: no render_swatch call" });
  }

  // C. A nested object schema, kept (made safe) by the default "warn" policy.
  const nestedWarnings: BridgeWarning[] = [];
  const nested = toBedrockToolConfig(
    [
      {
        name: "create_shipment",
        description: "Create a shipment to a postal address.",
        inputSchema: {
          type: "object",
          properties: {
            recipient: { type: "string" },
            address: {
              type: "object",
              properties: { street: { type: "string" }, city: { type: "string" }, postcode: { type: "string" } },
              required: ["street", "city"],
            },
          },
          required: ["recipient", "address"],
        },
      },
    ],
    { onWarning: (w) => nestedWarnings.push(w) },
  );
  const nestedResponse = await converse(
    "C. nested schema",
    [{ role: "user", content: [{ text: "Ship a parcel to Ada Lovelace, 12 Marylebone Road, London NW1." }] }],
    nested.toolConfig,
  );
  const nestedUse = toolUseOf(nestedResponse);
  const address = (nestedUse?.input as { address?: { city?: unknown } } | undefined)?.address;
  checks.push({
    check: "nested object schema",
    result: "INFO",
    details: nestedResponse
      ? `accepted, warnings: ${nestedWarnings.map((w) => w.code).join(",")}, toolUse: ${nestedUse ? JSON.stringify(nestedUse.input) : "none"}, address.city: ${String(address?.city)}`
      : `rejected: ${calls.at(-1)?.error}`,
  });

  // D. An untyped property ({ description } only, like zod's z.any()), kept by the "warn" policy.
  const untypedWarnings: BridgeWarning[] = [];
  const untyped = toBedrockToolConfig(
    [
      {
        name: "log_event",
        description: "Record an analytics event with a free-form payload.",
        inputSchema: {
          type: "object",
          properties: {
            event: { type: "string", description: "Event name" },
            payload: { description: "Any JSON value with the event details" },
          },
          required: ["event", "payload"],
        },
      },
    ],
    { onWarning: (w) => untypedWarnings.push(w) },
  );
  const untypedResponse = await converse(
    "D. untyped property",
    [{ role: "user", content: [{ text: "Log a signup event: plan pro, 3 seats." }] }],
    untyped.toolConfig,
  );
  const untypedUse = toolUseOf(untypedResponse);
  checks.push({
    check: "untyped property schema",
    result: "INFO",
    details: untypedResponse
      ? `accepted, warnings: ${untypedWarnings.map((w) => w.code).join(",")}, toolUse: ${untypedUse ? JSON.stringify(untypedUse.input) : `none (${untypedResponse.stopReason})`}`
      : `rejected: ${calls.at(-1)?.error}`,
  });

  return finish(mcp);
}

// In-process MCP server with the official SDK. orders.get_status has a dotted name (valid in
// MCP, not in Bedrock) and returns a short sentence plus structuredContent with the details.
async function startMcpServer(): Promise<Client> {
  const server = new McpServer({ name: "bridge-test", version: "1.0.0" });
  server.registerTool(
    "orders.get_status",
    {
      description: "Look up an order by id: status, carrier and estimated delivery date.",
      inputSchema: { order_id: z.string().describe("Order id, for example A-1") },
    },
    async ({ order_id }) => {
      const order = ORDERS[order_id.toUpperCase()];
      if (!order) return { content: [{ type: "text", text: `No order ${order_id}.` }], isError: true };
      // The carrier is only in structuredContent, so an answer that names it used the json block.
      return { content: [{ type: "text", text: `Found order ${order.order_id}.` }], structuredContent: order };
    },
  );
  server.registerTool(
    "render_swatch",
    {
      description: "Render the color swatch image of a product SKU.",
      inputSchema: { sku: z.string().describe("Product SKU, for example SKU-9") },
    },
    async ({ sku }) => ({
      content: [
        { type: "text", text: `Swatch for ${sku}.` },
        { type: "image", data: solidPng(64, 64, [220, 20, 20]).toString("base64"), mimeType: "image/png" },
      ],
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "bridge-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function converse(step: string, messages: Message[], toolConfig: ToolConfiguration): Promise<ConverseCommandOutput | undefined> {
  try {
    const response = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: SYSTEM,
        messages,
        toolConfig,
        inferenceConfig: { temperature: 0, maxTokens: 512 },
      }),
    );
    const use = toolUseOf(response);
    calls.push({ step, stopReason: response.stopReason, inputTokens: response.usage?.inputTokens, toolUse: use?.name });
    return response;
  } catch (error) {
    calls.push({ step, error: summarizeError(error) });
    return undefined;
  }
}

function toolUseOf(response: ConverseCommandOutput | undefined) {
  return response?.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
}

function textOf(response: ConverseCommandOutput | undefined): string {
  return (response?.output?.message?.content ?? []).flatMap((block) => (block.text ? [block.text] : [])).join(" ");
}

function safeToolCall(use: Parameters<typeof toMcpToolCall>[0], names: ToolNameMap) {
  try {
    return toMcpToolCall(use, names);
  } catch {
    return undefined;
  }
}

function record(check: string, ok: boolean, details: string) {
  checks.push({ check, result: ok ? "PASS" : "FAIL", details });
}

async function finish(mcp: Client) {
  await mcp.close();
  console.log("\nConverse calls:");
  console.table(calls);
  console.log("Checks:");
  console.table(checks);
  const failed = checks.filter((c) => c.result === "FAIL").length;
  const passed = checks.filter((c) => c.result === "PASS").length;
  if (failed > 0 || passed === 0) process.exitCode = 1;
  console.log(failed > 0 || passed === 0 ? `FAILED (${failed} failed, ${passed} passed)` : `OK (${passed} checks passed)`);
}

// Error name, HTTP status and a short message, with ARNs and account ids masked.
function summarizeError(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const message = error.message
    .replace(/arn:[\w-]+:[^\s"',;)]*/g, "[arn]")
    .replace(/\b\d{12}\b/g, "[account]")
    .slice(0, 300);
  return `${error.name}${status ? ` (HTTP ${status})` : ""}: ${message}`;
}

// A solid-color RGB PNG, built by hand so the script needs no image library.
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

main().catch((error: unknown) => {
  console.error(`test:bedrock failed: ${summarizeError(error)}`);
  process.exitCode = 1;
});
