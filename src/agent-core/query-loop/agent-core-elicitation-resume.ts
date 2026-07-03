import { appendMissingToolResults } from './agent-core-tool-result-pairing'
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopResult
} from './agent-core-query-types'
import type {
  AgentCoreElicitationRequest,
  AgentCoreToolCall,
  AgentCoreToolResult
} from '../tools/agent-core-tool-types'

export type AgentCoreElicitationResumeDecision =
  | {
      status: 'answer'
      answer: string
    }
  | {
      status: 'cancel'
      reason: string
    }

export type AgentCoreElicitationResumeArgs = {
  waitingResult: Extract<AgentCoreQueryLoopResult, { status: 'waiting-for-elicitation' }>
  decision: AgentCoreElicitationResumeDecision
}

export type AgentCoreElicitationResumeResult = {
  messages: AgentCoreMessage[]
  resumedCall: AgentCoreToolCall
}

// 找到最后一个包含工具调用的 assistant 消息；用户回答只恢复当前悬停的 assistant turn。
function lastAssistantToolCalls(messages: readonly AgentCoreMessage[]): AgentCoreToolCall[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      return message.toolCalls ?? []
    }
  }
  return []
}

// 从 ask_user 调用点开始截取工具列表；前面的工具已经完成，后面的工具要补 skipped。
function callsFromElicitationPoint(
  calls: readonly AgentCoreToolCall[],
  call: AgentCoreToolCall
): AgentCoreToolCall[] {
  const index = calls.findIndex((candidate) => candidate.id === call.id)
  return index >= 0 ? calls.slice(index) : [call]
}

// 校验用户答案是否满足 ask_user 的选项约束，防止 GUI/IPC 传入非法值。
function validateElicitationAnswer(
  request: AgentCoreElicitationRequest,
  answer: string
): AgentCoreToolResult | null {
  if (
    request.allowFreeform === true ||
    request.options === undefined ||
    request.options.length === 0
  ) {
    return null
  }
  if (request.options.includes(answer)) {
    return null
  }
  return {
    content: `Invalid user answer: ${answer}\nExpected one of: ${request.options.join(', ')}`,
    isError: true
  }
}

// 把用户回答转换成模型可消费的 tool_result 文本，保持 ask_user 的语义清晰。
function resultFromElicitationDecision(
  request: AgentCoreElicitationRequest,
  decision: AgentCoreElicitationResumeDecision
): AgentCoreToolResult {
  if (decision.status === 'cancel') {
    return {
      content: `User cancelled the question: ${decision.reason}`,
      isError: true
    }
  }
  const validationError = validateElicitationAnswer(request, decision.answer)
  if (validationError !== null) {
    return validationError
  }
  return {
    content: `User answer:\n${decision.answer}`
  }
}

// 追加 ask_user 的 tool_result，并向 timeline 发出对应事件。
function* appendElicitationResult(
  messages: AgentCoreMessage[],
  call: AgentCoreToolCall,
  result: AgentCoreToolResult
): Generator<AgentCoreQueryEvent, void> {
  messages.push({
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content: result.content,
    isError: result.isError
  })
  yield {
    type: 'tool-result',
    call,
    result
  }
}

// 恢复 waiting-for-elicitation 状态；返回的新 messages 可作为下一轮 query loop 输入。
export function* resumeAgentCoreElicitationDecision(
  args: AgentCoreElicitationResumeArgs
): Generator<AgentCoreQueryEvent, AgentCoreElicitationResumeResult> {
  const messages = [...args.waitingResult.messages]
  const calls = callsFromElicitationPoint(lastAssistantToolCalls(messages), args.waitingResult.call)
  const [call, ...remainingCalls] = calls
  if (call === undefined) {
    return {
      messages,
      resumedCall: args.waitingResult.call
    }
  }

  yield* appendElicitationResult(
    messages,
    call,
    resultFromElicitationDecision(args.waitingResult.request, args.decision)
  )
  yield* appendMissingToolResults(
    messages,
    remainingCalls,
    'Skipped because the previous ask_user call paused for user input.'
  )

  return {
    messages,
    resumedCall: args.waitingResult.call
  }
}
