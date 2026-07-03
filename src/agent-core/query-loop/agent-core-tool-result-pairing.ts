import type { AgentCoreMessage, AgentCoreQueryEvent } from './agent-core-query-types'
import type { AgentCoreToolCall, AgentCoreToolResult } from '../tools/agent-core-tool-types'

// 查询历史里已经存在 tool_result 的 id。补偿逻辑必须避免重复回灌同一个工具结果。
function completedToolCallIds(messages: readonly AgentCoreMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      ids.add(message.toolCallId)
    }
  }
  return ids
}

// 创建中断/错误时的 synthetic tool_result。原因写入模型上下文，让下一轮能理解发生了什么。
function createSyntheticToolResult(reason: string): AgentCoreToolResult {
  return {
    content: reason,
    isError: true,
    errorKind: 'interrupted-tool-call'
  }
}

// 补齐缺失的 tool_result。tool_result 补齐用于维持 tool_use -> tool_result 的协议不变量。
export function* appendMissingToolResults(
  messages: AgentCoreMessage[],
  calls: readonly AgentCoreToolCall[],
  reason: string
): Generator<AgentCoreQueryEvent, void> {
  const completedIds = completedToolCallIds(messages)
  for (const call of calls) {
    if (completedIds.has(call.id)) {
      continue
    }

    const result = createSyntheticToolResult(reason)
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: result.content,
      isError: true,
      errorKind: result.errorKind
    })
    yield {
      type: 'tool-result',
      call,
      result
    }
  }
}
