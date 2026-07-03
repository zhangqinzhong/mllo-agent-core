import {
  runPermissionRequestHooks,
  runPostToolFailureHooks,
  runPostToolHooks
} from './agent-core-tool-hook-step'
import type { AgentCoreHookDefinition } from '../hooks/agent-core-hook-types'
import type {
  AgentCoreToolCall,
  AgentCoreToolExecutionResult,
  AgentCoreToolOrchestrationUpdate
} from './agent-core-tool-types'

// 判断执行结果是否是权限暂停。暂停前要先跑 permission-request hook，不能等 query loop 返回后再补。
function isPermissionGateExecution(
  execution: AgentCoreToolExecutionResult
): execution is Extract<
  AgentCoreToolExecutionResult,
  { status: 'permission-required' | 'permission-denied' }
> {
  return execution.status === 'permission-required' || execution.status === 'permission-denied'
}

// 判断工具完成后应该进入哪个 post hook。工具异常会被 runner 包成 isError。
function isFailedToolExecution(execution: AgentCoreToolExecutionResult): boolean {
  return (
    execution.status === 'not-found' ||
    (execution.status === 'ok' && execution.result.isError === true)
  )
}

// 权限 gate 会导致 query loop 暂停，相关 hook 必须在 tool-complete 前被消费和持久化。
export async function* runPermissionGateHooks(args: {
  cwd: string
  call: AgentCoreToolCall
  execution: AgentCoreToolExecutionResult
  hooks: readonly AgentCoreHookDefinition[]
  signal?: AbortSignal
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  if (!isPermissionGateExecution(args.execution)) {
    return
  }

  yield* runPermissionRequestHooks({
    hooks: args.hooks,
    cwd: args.cwd,
    call: args.call,
    decision: args.execution.decision,
    signal: args.signal
  })
}

// 运行工具后的 hook。成功和失败分 phase，避免失败审计被普通 post hook 淹没。
export async function* runToolCompletionHooks(args: {
  cwd: string
  call: AgentCoreToolCall
  execution: AgentCoreToolExecutionResult
  hooks: readonly AgentCoreHookDefinition[]
  signal?: AbortSignal
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  if (isFailedToolExecution(args.execution)) {
    yield* runPostToolFailureHooks({
      hooks: args.hooks,
      cwd: args.cwd,
      call: args.call,
      result: args.execution.status === 'ok' ? args.execution.result : undefined,
      signal: args.signal
    })
    return
  }

  if (args.execution.status === 'ok') {
    yield* runPostToolHooks({
      hooks: args.hooks,
      cwd: args.cwd,
      call: args.call,
      result: args.execution.result,
      signal: args.signal
    })
  }
}
