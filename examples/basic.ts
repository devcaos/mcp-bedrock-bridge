// The README usage example. It is type-checked by `npm run typecheck`.
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
