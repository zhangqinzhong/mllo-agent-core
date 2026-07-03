import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  AgentCoreMcpToolCallResult,
  AgentCoreMcpToolDescriptor,
} from "./agent-core-mcp-client-types";

type AgentCoreMcpSdkCallToolResult = CallToolResult | { toolResult: unknown };

// MCP SDK wire shape 不稳定时，core 只保留自己的最小 tool 描述。
export function toAgentCoreMcpToolDescriptor(tool: Tool): AgentCoreMcpToolDescriptor {
  const descriptor: AgentCoreMcpToolDescriptor = {
    name: tool.name,
  };
  if (tool.description !== undefined) {
    descriptor.description = tool.description;
  }
  if (tool.inputSchema !== undefined) {
    descriptor.inputSchema = tool.inputSchema;
  }
  return descriptor;
}

// 不同 MCP SDK 版本可能返回 toolResult 或 content，这里统一成 core result。
export function toAgentCoreMcpToolCallResult(
  result: AgentCoreMcpSdkCallToolResult,
): AgentCoreMcpToolCallResult {
  if ("toolResult" in result) {
    return {
      content: result.toolResult,
    };
  }

  const content =
    result.structuredContent === undefined
      ? result.content
      : {
          content: result.content,
          structuredContent: result.structuredContent,
        };
  const mapped: AgentCoreMcpToolCallResult = {
    content,
  };
  if (result.isError !== undefined) {
    mapped.isError = result.isError;
  }
  return mapped;
}
