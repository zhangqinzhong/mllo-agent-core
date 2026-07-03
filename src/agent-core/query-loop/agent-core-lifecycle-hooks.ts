import { runAgentCoreHooks } from '../hooks/agent-core-hook-runner'
import type { AgentCoreHookPhase, AgentCoreHookRunResult } from '../hooks/agent-core-hook-types'
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult
} from './agent-core-query-types'

// 找到本轮用户输入。hook 需要看到用户原始意图，而不是只看压缩后的消息数组。
export function latestUserPrompt(messages: readonly AgentCoreMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user') {
      return message.content
    }
  }
  return undefined
}

// 运行 session 生命周期 hook。它覆盖 run 开始、用户输入提交、run 结束这些非工具阶段。
export async function* runLifecycleHooksStep(args: {
  queryArgs: AgentCoreQueryLoopArgs
  phase: AgentCoreHookPhase
  userPrompt?: string
  sessionStatus?: string
}): AsyncGenerator<AgentCoreQueryEvent, AgentCoreHookRunResult> {
  return yield* runAgentCoreHooks({
    hooks: args.queryArgs.hooks ?? [],
    context: {
      phase: args.phase,
      cwd: args.queryArgs.cwd,
      userPrompt: args.userPrompt,
      sessionStatus: args.sessionStatus,
      signal: args.queryArgs.signal
    }
  })
}

// lifecycle hook 阻止运行时，统一转成 queryLoop error 终态。
export function lifecycleBlockedResult(
  messages: AgentCoreMessage[],
  reason: string | undefined
): Extract<AgentCoreQueryLoopResult, { status: 'error' }> {
  return {
    status: 'error',
    messages,
    message: reason ?? 'Lifecycle hook blocked agent run.'
  }
}

// session-end 只做审计和外部联动，不反向改写已经形成的终态。
export async function* finishWithSessionEndHooks(
  args: AgentCoreQueryLoopArgs,
  result: AgentCoreQueryLoopResult
): AsyncGenerator<AgentCoreQueryEvent, AgentCoreQueryLoopResult> {
  if (result.status !== 'waiting-for-permission') {
    yield* runLifecycleHooksStep({
      queryArgs: args,
      phase: 'session-end',
      sessionStatus: result.status
    })
  }
  return result
}

// stop hook 自身失败时执行 stop-failure hook；它只负责审计和恢复联动，不吞掉错误。
export async function* runStopFailureHooksStep(args: {
  queryArgs: AgentCoreQueryLoopArgs
  content: string
  reason: string | undefined
}): AsyncGenerator<AgentCoreQueryEvent, AgentCoreHookRunResult> {
  return yield* runAgentCoreHooks({
    hooks: args.queryArgs.hooks ?? [],
    context: {
      phase: 'stop-failure',
      cwd: args.queryArgs.cwd,
      finalContent: args.content,
      stopFailureReason: args.reason,
      signal: args.queryArgs.signal
    }
  })
}
