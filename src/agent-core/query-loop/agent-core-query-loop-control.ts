import { finishWithSessionEndHooks } from './agent-core-lifecycle-hooks'
import type { AgentCoreMiddlewareChain } from '../middleware/agent-core-middleware-chain'
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult
} from './agent-core-query-types'

export function isAgentCoreQueryStopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export function createStoppedAgentCoreQueryLoopResult(
  messages: AgentCoreMessage[],
  reason: string
): AgentCoreQueryLoopResult {
  return {
    status: 'stopped',
    messages,
    reason
  }
}

export async function* finishAgentCoreQueryLoopResult(args: {
  queryArgs: AgentCoreQueryLoopArgs
  messages: AgentCoreMessage[]
  middlewareChain: AgentCoreMiddlewareChain
  result: AgentCoreQueryLoopResult
}): AsyncGenerator<AgentCoreQueryEvent, AgentCoreQueryLoopResult> {
  const middlewareResult = await args.middlewareChain.afterAgent({
    queryArgs: args.queryArgs,
    messages: args.messages,
    result: args.result
  })
  return yield* finishWithSessionEndHooks(args.queryArgs, middlewareResult)
}
