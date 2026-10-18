import type { ContentBlock, ImageBlock, ImageFormat, ToolResultContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { decodeBase64, depthOption, enumOption, isPlainObject, own, quote, warnToConsole } from "./runtime.ts";
import type { McpCallToolResult, McpCompatibilityCallToolResult, WarningHandler } from "./types.ts";

// Builds the Converse toolResult for an MCP tools/call result.
// The rule that matters: never put `text` and `json` blocks in the same toolResult. The Nova docs
// say the content "should be either a single JSON or a mix of text and images", and when Duly
// broke that rule Bedrock didn't fail: it silently dropped the tool definitions from the prompt
// (https://github.com/devcaos/duly/blob/main/FRICTION.md).
// So a result with structuredContent becomes one json block, and any other result becomes one
// text block, plus image blocks when the result has images.

export type TextMode = "auto" | "always" | "never";

export interface ToBedrockToolResultOptions {
  /**
   * How the text of a result with structuredContent is kept (default "auto"):
   * - "auto": dropped when it is only the JSON serialization of structuredContent (the MCP spec
   *   asks servers to send that copy); otherwise kept as `{ result: structuredContent, text }`.
   * - "always": always `{ result: structuredContent, text }` when there is text.
   * - "never": always dropped.
   * Any other value throws a TypeError; null uses the default.
   */
  textMode?: TextMode;
  /** Send `status: "success" | "error"` (default true). Bedrock documents it for Nova and Claude 3/4 only. */
  includeStatus?: boolean;
  /** Text sent when the result has no content at all (default "(no content)"). Must not be blank. */
  emptyText?: string;
  /**
   * Maximum nesting depth used when comparing the text with structuredContent, an integer from
   * 1 to 256 (default 32; null uses the default).
   */
  maxJsonDepth?: number;
  /** Called for every piece of content that was left out (default: console.warn). */
  onWarning?: WarningHandler;
}

// Bedrock API Reference, ToolResultBlock: 1-64 characters.
const TOOL_USE_ID = /^[a-zA-Z0-9_.:-]{1,64}$/;
// Bedrock API Reference, ImageBlock: png | jpeg | gif | webp.
// A Map, not an object literal: the key is an untrusted mimeType such as "constructor".
const IMAGE_FORMATS = new Map<string, ImageFormat>([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/jpg", "jpeg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);
const DEFAULT_MAX_JSON_DEPTH = 32;
const TEXT_MODES: readonly TextMode[] = ["auto", "always", "never"];

/**
 * Converts an MCP CallToolResult into a Converse content block `{ toolResult }`, ready for
 * `messages.push({ role: "user", content: [block] })`.
 */
export function toBedrockToolResult(
  toolUseId: string,
  mcpResult: McpCallToolResult | McpCompatibilityCallToolResult,
  options: ToBedrockToolResultOptions = {},
): ContentBlock.ToolResultMember {
  if (typeof toolUseId !== "string" || !TOOL_USE_ID.test(toolUseId)) {
    throw new TypeError("toolUseId must be the toolUseId of the model's toolUse block (1-64 of [a-zA-Z0-9_.:-])");
  }
  const textMode = enumOption("textMode", options.textMode, TEXT_MODES, "auto");
  const maxJsonDepth = depthOption("maxJsonDepth", options.maxJsonDepth, DEFAULT_MAX_JSON_DEPTH);
  const emptyText = options.emptyText ?? "(no content)";
  if (typeof emptyText !== "string" || emptyText.trim().length === 0) throw new TypeError("emptyText must be a non-blank string");
  const onWarning = options.onWarning ?? warnToConsole;
  const omitted = (what: string) =>
    onWarning({ code: "content-omitted", toolUseId, message: `Tool result ${toolUseId}: ${what}.` });

  if (!isPlainObject(mcpResult)) {
    onWarning({ code: "invalid-result", toolUseId, message: `Tool result ${toolUseId}: the MCP result isn't a plain object, sent as an empty result.` });
  }
  const result = (isPlainObject(mcpResult) ? mcpResult : {}) as Record<string, unknown>;
  const { texts, images } = collectContent(own(result, "content"), omitted);

  let structured = own(result, "structuredContent");
  // Pre-2025 servers answer with `{ toolResult }` instead of content.
  if (structured === undefined && own(result, "content") === undefined && Object.hasOwn(result, "toolResult")) {
    structured = own(result, "toolResult");
  }

  const text = texts.join("\n\n");
  let content: ToolResultContentBlock[];
  if (structured !== undefined) {
    if (images.length > 0) omitted(`${images.length} image(s) left out, a result with structuredContent is sent as a single json block`);
    const keepText = text.length > 0 && keepTextWith(structured, text, textMode, maxJsonDepth);
    const json = keepText ? { result: structured, text } : isPlainObject(structured) ? structured : { result: structured };
    content = [{ json } as ToolResultContentBlock.JsonMember];
  } else {
    content = [...(text.length > 0 ? [{ text }] : []), ...images.map((image) => ({ image }))];
    if (content.length === 0) content = [{ text: emptyText }];
  }

  const isError = own(result, "isError") === true;
  return {
    toolResult: {
      toolUseId,
      content,
      ...(options.includeStatus === false ? {} : { status: isError ? "error" : "success" }),
    },
  };
}

function keepTextWith(structured: unknown, text: string, mode: TextMode, maxDepth: number): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return !isJsonCopy(text, structured, maxDepth);
}

// True when the text parses as JSON equal to the value (key order and whitespace don't matter).
function isJsonCopy(text: string, value: unknown, maxDepth: number): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return jsonEqual(parsed, value, 0, maxDepth);
}

function jsonEqual(a: unknown, b: unknown, depth: number, maxDepth: number): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return a === b;
  if (depth >= maxDepth) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i], depth + 1, maxDepth));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  // JSON.stringify drops undefined values, so a key set to undefined counts as missing.
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k], depth + 1, maxDepth));
}

// Text and image blocks from MCP content. Content Bedrock can't take (audio, other binary
// resources, unknown types) becomes a short text marker, so the model knows something was there.
function collectContent(content: unknown, omitted: (what: string) => void): { texts: string[]; images: ImageBlock[] } {
  const texts: string[] = [];
  const images: ImageBlock[] = [];
  if (!Array.isArray(content)) return { texts, images };

  for (const block of content as unknown[]) {
    if (!isPlainObject(block)) {
      omitted("a content item that isn't an object was left out");
      continue;
    }
    const type = own(block, "type");
    const mimeType = stringOr(own(block, "mimeType"), "unknown type");
    switch (type) {
      case "text": {
        const text = own(block, "text");
        // Whitespace-only text counts as no text, so it never becomes a blank text block.
        if (typeof text === "string" && text.trim().length > 0) texts.push(text);
        break;
      }
      case "image": {
        const image = toImage(own(block, "data"), mimeType);
        if (image) images.push(image);
        else {
          texts.push(`[image omitted: ${mimeType}]`);
          omitted(
            IMAGE_FORMATS.has(mimeType.toLowerCase())
              ? `an image (${quote(mimeType)}) with empty or invalid base64 data was replaced by a marker`
              : `an image (${quote(mimeType)}) was replaced by a marker, Bedrock takes png, jpeg, gif or webp`,
          );
        }
        break;
      }
      case "audio":
        texts.push(`[audio omitted: ${mimeType}]`);
        omitted(`audio (${quote(mimeType)}) was replaced by a marker, Bedrock tool results can't hold audio`);
        break;
      case "resource_link": {
        const uri = stringOr(own(block, "uri"), "");
        const name = stringOr(own(block, "name"), uri);
        const mime = own(block, "mimeType") === undefined ? "" : `, ${mimeType}`;
        texts.push(`[resource link: ${name} (${uri}${mime})]`);
        break;
      }
      case "resource": {
        const resource = own(block, "resource");
        const r = isPlainObject(resource) ? resource : {};
        const uri = stringOr(own(r, "uri"), "unknown uri");
        const resourceMime = stringOr(own(r, "mimeType"), "unknown type");
        const text = own(r, "text");
        const image = typeof own(r, "blob") === "string" ? toImage(own(r, "blob"), resourceMime) : undefined;
        if (typeof text === "string") texts.push(`[resource ${uri}]\n${text}`);
        else if (image) images.push(image);
        else {
          texts.push(`[resource omitted: ${uri} (${resourceMime})]`);
          omitted(`a binary resource (${quote(resourceMime)}) was replaced by a marker`);
        }
        break;
      }
      default:
        texts.push(`[content omitted: ${stringOr(type, "unknown")}]`);
        omitted(`content of type ${quote(String(type), 40)} was replaced by a marker`);
    }
  }
  return { texts, images };
}

function toImage(data: unknown, mimeType: string): ImageBlock | undefined {
  const format = IMAGE_FORMATS.get(mimeType.toLowerCase());
  if (!format || typeof data !== "string") return undefined;
  try {
    const bytes = decodeBase64(data);
    // ImageSource.bytes needs at least 1 byte: an empty image would make Bedrock reject the request.
    return bytes.length > 0 ? { format, source: { bytes } } : undefined;
  } catch {
    return undefined;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.slice(0, 200) : fallback;
}
