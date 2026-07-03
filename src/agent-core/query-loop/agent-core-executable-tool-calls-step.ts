import { runAgentCoreToolCalls } from '../tools/agent-core-tool-orchestration'
import type {
  AgentCoreToolCall,
  AgentCoreToolExecutionResult
} from '../tools/agent-core-tool-types'
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult
} from './agent-core-query-types'
import type { AgentCoreMiddlewareChain } from '../middleware/agent-core-middleware-chain'

export type AgentCoreToolCompletionHandler = (args: {
  call: AgentCoreToolCall
  execution: AgentCoreToolExecutionResult
  remainingCalls?: readonly AgentCoreToolCall[]
}) => AsyncGenerator<AgentCoreQueryEvent, AgentCoreQueryLoopResult | null>

// 执行一组真实工具调用。synthetic guard 已在调用方处理，这里只负责真实编排事件。
export async function* runExecutableAgentCoreToolCallsStep(args: {
  queryArgs: AgentCoreQueryLoopArgs
  messages: AgentCoreMessage[]
  calls: readonly AgentCoreToolCall[]
  middlewareChain: AgentCoreMiddlewareChain
  remainingCallsAfter: (call: AgentCoreToolCall) => readonly AgentCoreToolCall[]
  onToolComplete: AgentCoreToolCompletionHandler
}): AsyncGenerator<AgentCoreQueryEvent, AgentCoreQueryLoopResult | null> {
  for await (const update of runAgentCoreToolCalls({
    calls: args.calls,
    cwd: args.queryArgs.cwd,
    signal: args.queryArgs.signal,
    tools: args.queryArgs.tools ?? [],
    hooks: args.queryArgs.hooks ?? [],
    requestWorkerPermission: args.queryArgs.requestWorkerPermission
  })) {
    if (update.type === 'hook-event') {
      yield update
      continue
    }

    if (update.type === 'tool-start') {
      yield {
        type: 'tool-call',
        call: update.call
      }
      continue
    }

    if (update.type === 'tool-progress') {
      yield update
      continue
    }

    const result = yield* args.onToolComplete({
      call: update.call,
      execution: update.execution,
      remainingCalls: args.remainingCallsAfter(update.call)
    })
    if (result !== null) {
      return result
    }
  }

  return null
}
