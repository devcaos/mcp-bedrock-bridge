import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { toBedrockToolResult } from "../src/index.ts";
import type { BridgeWarning, McpCallToolResult, ToBedrockToolResultOptions } from "../src/index.ts";

const PNG_BASE64 = "iVBORw0KGgo="; // the 8-byte PNG signature is enough here
const produced: ContentBlock.ToolResultMember[] = [];

function convert(result: McpCallToolResult, options: ToBedrockToolResultOptions = {}) {
  const warnings: BridgeWarning[] = [];
  const block = toBedrockToolResult("tooluse_abc-1", result, { onWarning: (w) => warnings.push(w), ...options });
  produced.push(block);
  return { toolResult: block.toolResult, content: block.toolResult.content ?? [], warnings };
}

// The rule this library exists for: never text and json in the same toolResult.
afterEach(() => {
  for (const block of produced.splice(0)) {
    const content = block.toolResult.content ?? [];
    const hasJson = content.some((c) => c.json !== undefined);
    assert.ok(!(hasJson && content.length > 1), "a json block must be the only block");
  }
});

const order = { order_id: "A-1", status: "shipped", eta: "2026-10-21" };

describe("toBedrockToolResult: text results", () => {
  it("turns a text result into one text block with status success", () => {
    const { toolResult } = convert({ content: [{ type: "text", text: "Order A-1 has shipped." }] });
    assert.deepEqual(toolResult, {
      toolUseId: "tooluse_abc-1",
      content: [{ text: "Order A-1 has shipped." }],
      status: "success",
    });
  });

  it("joins several text blocks into one", () => {
    const { content } = convert({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] });
    assert.deepEqual(content, [{ text: "one\n\ntwo" }]);
  });

  it("maps isError to status error", () => {
    const { toolResult } = convert({ content: [{ type: "text", text: "Order not found." }], isError: true });
    assert.equal(toolResult.status, "error");
    assert.deepEqual(toolResult.content, [{ text: "Order not found." }]);
  });

  it("can leave out status", () => {
    const { toolResult } = convert({ content: [{ type: "text", text: "x" }], isError: true }, { includeStatus: false });
    assert.equal(Object.hasOwn(toolResult, "status"), false);
  });

  it("sends a placeholder for empty content", () => {
    assert.deepEqual(convert({ content: [] }).content, [{ text: "(no content)" }]);
    assert.deepEqual(convert({} as McpCallToolResult).content, [{ text: "(no content)" }]);
    assert.deepEqual(convert({ content: [] }, { emptyText: "Done." }).content, [{ text: "Done." }]);
  });

  it("rejects an invalid toolUseId", () => {
    for (const id of ["", "has space", "x".repeat(65)]) {
      assert.throws(() => toBedrockToolResult(id, { content: [] }), TypeError);
    }
  });
});

describe("toBedrockToolResult: structuredContent", () => {
  it("auto: drops text that is only the JSON copy (any key order or spacing)", () => {
    const text = '{\n  "eta": "2026-10-21",\n  "status": "shipped",\n  "order_id": "A-1"\n}';
    const { content } = convert({ content: [{ type: "text", text }], structuredContent: order });
    assert.deepEqual(content, [{ json: order }]);
  });

  it("auto: keeps a human sentence as { result, text } in the single json block", () => {
    const { content } = convert({
      content: [{ type: "text", text: "Order A-1 shipped and arrives on 21 October." }],
      structuredContent: order,
    });
    assert.deepEqual(content, [{ json: { result: order, text: "Order A-1 shipped and arrives on 21 October." } }]);
  });

  it("auto: keeps JSON text that differs from structuredContent", () => {
    const { content } = convert({
      content: [{ type: "text", text: JSON.stringify({ ...order, status: "lost" }) }],
      structuredContent: order,
    });
    assert.deepEqual(content, [{ json: { result: order, text: JSON.stringify({ ...order, status: "lost" }) } }]);
  });

  it("always: keeps even the JSON copy", () => {
    const text = JSON.stringify(order);
    const { content } = convert({ content: [{ type: "text", text }], structuredContent: order }, { textMode: "always" });
    assert.deepEqual(content, [{ json: { result: order, text } }]);
  });

  it("always: without text, sends structuredContent alone", () => {
    const { content } = convert({ content: [], structuredContent: order }, { textMode: "always" });
    assert.deepEqual(content, [{ json: order }]);
  });

  it("never: drops even a human sentence", () => {
    const { content } = convert(
      { content: [{ type: "text", text: "Order A-1 has shipped." }], structuredContent: order },
      { textMode: "never" },
    );
    assert.deepEqual(content, [{ json: order }]);
  });

  it("wraps structuredContent that isn't an object in { result }", () => {
    assert.deepEqual(convert({ content: [], structuredContent: [1, 2] }).content, [{ json: { result: [1, 2] } }]);
    assert.deepEqual(convert({ content: [], structuredContent: null }).content, [{ json: { result: null } }]);
    assert.deepEqual(convert({ content: [{ type: "text", text: "7" }], structuredContent: 7 }).content, [
      { json: { result: 7 } },
    ]);
  });

  it("keeps status error with structuredContent", () => {
    const { toolResult } = convert({ content: [], structuredContent: { error: "timeout" }, isError: true });
    assert.equal(toolResult.status, "error");
    assert.deepEqual(toolResult.content, [{ json: { error: "timeout" } }]);
  });

  it("accepts the old { toolResult } shape", () => {
    const block = toBedrockToolResult("id1", { toolResult: { ok: true } });
    assert.deepEqual(block.toolResult.content, [{ json: { ok: true } }]);
  });

  it("treats text nested deeper than maxJsonDepth as not a copy", () => {
    const deep = { a: { b: { c: 1 } } };
    const text = JSON.stringify(deep);
    assert.deepEqual(convert({ content: [{ type: "text", text }], structuredContent: deep }, { maxJsonDepth: 2 }).content, [
      { json: { result: deep, text } },
    ]);
  });
});

describe("toBedrockToolResult: images, audio and resources", () => {
  it("sends text and images as one text block plus image blocks", () => {
    const { content } = convert({
      content: [
        { type: "text", text: "Here is the chart." },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ],
    });
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { text: "Here is the chart." });
    assert.equal(content[1]?.image?.format, "png");
    const bytes = content[1]?.image?.source?.bytes;
    assert.ok(bytes instanceof Uint8Array);
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it("sends an image-only result as image blocks", () => {
    const { content } = convert({ content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] });
    assert.equal(content.length, 1);
    assert.equal(content[0]?.image?.format, "png");
  });

  it("leaves images out of a structuredContent result, with a warning", () => {
    const { content, warnings } = convert({
      content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
      structuredContent: order,
    });
    assert.deepEqual(content, [{ json: order }]);
    assert.equal(warnings[0]?.code, "content-omitted");
  });

  it("replaces unsupported images and audio with markers", () => {
    const { content, warnings } = convert({
      content: [
        { type: "image", data: PNG_BASE64, mimeType: "image/svg+xml" },
        { type: "image", data: PNG_BASE64, mimeType: "constructor" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      ],
    });
    assert.deepEqual(content, [
      { text: "[image omitted: image/svg+xml]\n\n[image omitted: constructor]\n\n[audio omitted: audio/wav]" },
    ]);
    assert.equal(warnings.length, 3);
  });

  it("describes resource links in text", () => {
    const { content } = convert({
      content: [{ type: "resource_link", uri: "file:///docs/a.pdf", name: "a.pdf", mimeType: "application/pdf" }],
    });
    assert.deepEqual(content, [{ text: "[resource link: a.pdf (file:///docs/a.pdf, application/pdf)]" }]);
  });

  it("embeds text resources and image blobs, and marks other blobs", () => {
    const { content, warnings } = convert({
      content: [
        { type: "resource", resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "hello" } },
        { type: "resource", resource: { uri: "file:///b.png", mimeType: "image/png", blob: PNG_BASE64 } },
        { type: "resource", resource: { uri: "file:///c.zip", mimeType: "application/zip", blob: "UEsDBA==" } },
      ],
    });
    assert.deepEqual(content[0], { text: "[resource file:///a.txt]\nhello\n\n[resource omitted: file:///c.zip (application/zip)]" });
    assert.equal(content[1]?.image?.format, "png");
    assert.equal(warnings.length, 1);
  });

  it("marks unknown content types and invalid base64", () => {
    const { content, warnings } = convert({
      content: [
        { type: "video", data: "x" },
        { type: "image", data: "%%%not base64%%%", mimeType: "image/png" },
      ],
    });
    assert.deepEqual(content, [{ text: "[content omitted: video]\n\n[image omitted: image/png]" }]);
    assert.equal(warnings.length, 2);
  });
});
