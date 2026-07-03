import type { AgentCoreMessage } from '../query-loop/agent-core-query-types'
import type { AgentCoreToolCall } from '../tools/agent-core-tool-types'
import type {
  AgentCoreBudgetPolicy,
  AgentCoreToolResultBudgetProfile
} from './agent-core-budget-types'
import { createAgentCoreFileToolCallProjection } from './agent-core-file-tool-call-projection'

export type AgentCoreToolResultBudgetStats = {
  toolResultsCompacted: number
  microCompactedToolResults: number
  toolCallInputsCompacted: number
}

export type AgentCoreToolResultBudgetResult = {
  messages: AgentCoreMessage[]
  stats: AgentCoreToolResultBudgetStats
}

type ToolMessage = Extract<AgentCoreMessage, { role: 'tool' }>
type AssistantMessage = Extract<AgentCoreMessage, { role: 'assistant' }>
type ResolvedToolResultBudgetProfile = Required<AgentCoreToolResultBudgetProfile>

// 判断消息是否是工具结果。预算层只压缩工具输出，不改用户/助手原始语义。
function isToolMessage(message: AgentCoreMessage): message is ToolMessage {
  return message.role === 'tool'
}

// 判断消息是否带工具调用。文件写入类 input 可能比工具结果更大，也要先预算。
function isAssistantMessage(message: AgentCoreMessage): message is AssistantMessage {
  return message.role === 'assistant'
}

// 为单个工具解析预算 profile。没有专门配置时退回全局工具结果预算。
function resolveToolResultProfile(
  toolName: string,
  policy: AgentCoreBudgetPolicy
): ResolvedToolResultBudgetProfile {
  const override = policy.toolResultProfiles[toolName] ?? {}
  return {
    maxToolResultChars: override.maxToolResultChars ?? policy.maxToolResultChars,
    preservedToolResultHeadChars:
      override.preservedToolResultHeadChars ?? policy.preservedToolResultHeadChars,
    preservedToolResultTailChars:
      override.preservedToolResultTailChars ?? policy.preservedToolResultTailChars,
    microCompactToolResultChars:
      override.microCompactToolResultChars ?? policy.microCompactToolResultChars
  }
}

// 把投影后的工具调用包装成显式协议对象，避免模型误以为这是原始 input。
function createProjectedToolCall(
  call: AgentCoreToolCall,
  policy: AgentCoreBudgetPolicy
): {
  call: AgentCoreToolCall
  compacted: boolean
} {
  const profile = resolveToolResultProfile(call.name, policy)
  const projection = createAgentCoreFileToolCallProjection({
    call,
    budget: profile
  })
  if (projection === undefined) {
    return {
      call,
      compacted: false
    }
  }
  return {
    call: {
      ...call,
      input: {
        kind: 'mllo_file_tool_call_projection',
        toolName: projection.toolName,
        originalInputLength: projection.originalInputLength,
        projectedInput: projection.projectedInput
      }
    },
    compacted: true
  }
}

// 对 assistant toolCalls 做预算。这样 write_file 的整文件 content 不会长期撑爆上下文。
function applyAssistantToolCallInputBudget(
  message: AssistantMessage,
  policy: AgentCoreBudgetPolicy
): {
  message: AgentCoreMessage
  compactedCount: number
} {
  if (message.toolCalls === undefined || message.toolCalls.length === 0) {
    return {
      message,
      compactedCount: 0
    }
  }
  let compactedCount = 0
  const toolCalls = message.toolCalls.map((call) => {
    const result = createProjectedToolCall(call, policy)
    if (result.compacted) {
      compactedCount += 1
    }
    return result.call
  })
  if (compactedCount === 0) {
    return {
      message,
      compactedCount
    }
  }
  return {
    message: {
      ...message,
      toolCalls
    },
    compactedCount
  }
}

// 生成工具输出压缩标记。模型需要知道这里是预算裁剪，不是工具真的只输出这些内容。
function renderCompactedToolResult(args: {
  kind: 'tool-result-budget' | 'microcompact'
  toolName: string
  originalLength: number
  head: string
  tail?: string
}): string {
  return [
    `<mllo_${args.kind}>`,
    `toolName: ${args.toolName}`,
    `originalLength: ${args.originalLength}`,
    `preservedHeadLength: ${args.head.length}`,
    `preservedTailLength: ${args.tail?.length ?? 0}`,
    '',
    args.head,
    ...(args.tail === undefined || args.tail.length === 0 ? [] : ['', '--- tail ---', args.tail]),
    `</mllo_${args.kind}>`
  ].join('\n')
}

// 限制单个超大工具结果。保留头尾能兼顾命令开头上下文和最终错误/统计。
function applySingleToolResultBudget(
  message: ToolMessage,
  profile: ResolvedToolResultBudgetProfile
): {
  message: AgentCoreMessage
  compacted: boolean
} {
  if (message.content.length <= profile.maxToolResultChars) {
    return {
      message,
      compacted: false
    }
  }
  const head = message.content.slice(0, profile.preservedToolResultHeadChars)
  const tail = message.content.slice(-profile.preservedToolResultTailChars)
  return {
    message: {
      ...message,
      content: renderCompactedToolResult({
        kind: 'tool-result-budget',
        toolName: message.name,
        originalLength: message.content.length,
        head,
        tail
      })
    },
    compacted: true
  }
}

// 对较旧工具结果做 microcompact。最近工具结果保留更多细节，旧工具结果只保留摘要线索。
function applySingleToolResultMicroCompact(
  message: ToolMessage,
  profile: ResolvedToolResultBudgetProfile
): {
  message: AgentCoreMessage
  compacted: boolean
} {
  if (message.content.length <= profile.microCompactToolResultChars) {
    return {
      message,
      compacted: false
    }
  }
  return {
    message: {
      ...message,
      content: renderCompactedToolResult({
        kind: 'microcompact',
        toolName: message.name,
        originalLength: message.content.length,
        head: message.content.slice(0, profile.microCompactToolResultChars)
      })
    },
    compacted: true
  }
}

// 处理最近的工具结果。最近内容还可能指导下一步，所以只对超大输出做头尾预算。
function applyRecentToolResultBudget(
  message: ToolMessage,
  profile: ResolvedToolResultBudgetProfile
): {
  message: AgentCoreMessage
  compacted: boolean
} {
  return applySingleToolResultBudget(message, profile)
}

// 处理较旧的工具结果。旧输出优先微压缩，避免历史 stdout 长期占据上下文。
function applyOlderToolResultBudget(
  message: ToolMessage,
  profile: ResolvedToolResultBudgetProfile
): {
  message: AgentCoreMessage
  toolResultCompacted: boolean
  microCompacted: boolean
} {
  const microResult = applySingleToolResultMicroCompact(message, profile)
  if (microResult.compacted) {
    return {
      message: microResult.message,
      toolResultCompacted: false,
      microCompacted: true
    }
  }
  const budgetResult = applySingleToolResultBudget(message, profile)
  return {
    message: budgetResult.message,
    toolResultCompacted: budgetResult.compacted,
    microCompacted: false
  }
}

// 先压缩工具结果，再考虑整段 transcript compact。这样摘要器不会被巨大 stdout 淹没。
export function applyAgentCoreToolResultBudget(
  messages: readonly AgentCoreMessage[],
  policy: AgentCoreBudgetPolicy
): AgentCoreToolResultBudgetResult {
  let remainingRecentToolResults = policy.microCompactPreservedRecentToolResults
  let toolResultsCompacted = 0
  let microCompactedToolResults = 0
  let toolCallInputsCompacted = 0
  const nextMessages: AgentCoreMessage[] = []

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (isAssistantMessage(message)) {
      const result = applyAssistantToolCallInputBudget(message, policy)
      toolCallInputsCompacted += result.compactedCount
      nextMessages.unshift(result.message)
      continue
    }
    if (!isToolMessage(message)) {
      nextMessages.unshift(message)
      continue
    }
    const profile = resolveToolResultProfile(message.name, policy)
    if (remainingRecentToolResults > 0) {
      remainingRecentToolResults -= 1
      const result = applyRecentToolResultBudget(message, profile)
      if (result.compacted) {
        toolResultsCompacted += 1
      }
      nextMessages.unshift(result.message)
      continue
    }
    const result = applyOlderToolResultBudget(message, profile)
    if (result.microCompacted) {
      microCompactedToolResults += 1
    }
    if (result.toolResultCompacted) {
      toolResultsCompacted += 1
    }
    nextMessages.unshift(result.message)
  }

  return {
    messages: nextMessages,
    stats: {
      toolResultsCompacted,
      microCompactedToolResults,
      toolCallInputsCompacted
    }
  }
}
