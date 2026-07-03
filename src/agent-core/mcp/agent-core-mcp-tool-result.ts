import type { AgentCoreMcpToolCallResult } from './agent-core-mcp-client-types'

const DEFAULT_MAX_MCP_RESULT_CHARS = 200_000

function stringifyMcpContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2)
}

// MCP 返回可以是对象或文本；工具结果必须统一成模型能消费的字符串。
export function formatAgentCoreMcpToolResult(
  result: AgentCoreMcpToolCallResult,
  maxChars: number = DEFAULT_MAX_MCP_RESULT_CHARS
): string {
  const content = stringifyMcpContent(result.content)
  if (content.length <= maxChars) {
    return content
  }
  return `${content.slice(0, maxChars)}\n\n[MCP tool result truncated after ${maxChars} chars]`
}
