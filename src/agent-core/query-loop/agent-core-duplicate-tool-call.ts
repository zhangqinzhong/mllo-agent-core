import type {
  AgentCoreToolCall,
  AgentCoreToolExecutionResult
} from '../tools/agent-core-tool-types'
import { createAgentCoreToolCallSignature } from './agent-core-tool-call-signature'

export type AgentCoreDuplicateToolCallTracker = {
  seen: Map<string, AgentCoreToolCall>
}

export function createAgentCoreDuplicateToolCallTracker(): AgentCoreDuplicateToolCallTracker {
  return {
    seen: new Map()
  }
}

function duplicateToolCallResult(args: {
  call: AgentCoreToolCall
  originalCall: AgentCoreToolCall
}): AgentCoreToolExecutionResult {
  return {
    status: 'ok',
    result: {
      isError: true,
      errorKind: 'duplicate-call',
      content: [
        `Duplicate tool call skipped for ${args.call.name}.`,
        `This turn already requested the same tool with the same JSON arguments as ${args.originalCall.id}.`,
        'Use the earlier tool result; do not issue identical parallel calls unless the arguments differ.'
      ].join('\n')
    }
  }
}

// 标记当前调用；如果同一轮已有同名同参数调用，则返回 synthetic 工具结果。
export function markAgentCoreDuplicateToolCall(args: {
  tracker: AgentCoreDuplicateToolCallTracker
  call: AgentCoreToolCall
}): AgentCoreToolExecutionResult | undefined {
  const signature = createAgentCoreToolCallSignature(args.call)
  const originalCall = args.tracker.seen.get(signature)
  if (originalCall !== undefined) {
    return duplicateToolCallResult({
      call: args.call,
      originalCall
    })
  }
  args.tracker.seen.set(signature, args.call)
  return undefined
}

// 预判剩余调用里是否包含同批重复；用于保留正常无重复时的并发快路径。
export function hasAgentCoreDuplicateToolCall(args: {
  tracker: AgentCoreDuplicateToolCallTracker
  calls: readonly AgentCoreToolCall[]
}): boolean {
  const seen = new Set(args.tracker.seen.keys())
  for (const call of args.calls) {
    const signature = createAgentCoreToolCallSignature(call)
    if (seen.has(signature)) {
      return true
    }
    seen.add(signature)
  }
  return false
}
