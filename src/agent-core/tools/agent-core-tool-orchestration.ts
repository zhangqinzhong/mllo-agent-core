import { runPermissionGateHooks, runToolCompletionHooks } from './agent-core-tool-completion-hooks'
import { runConcurrentAgentCoreToolBatch } from './agent-core-concurrent-tool-batch'
import { runPreToolHooks } from './agent-core-tool-hook-step'
import { emitToolProgressWithHooks } from './agent-core-tool-progress-hooks'
import {
  startRunningAgentCoreTool,
  waitForRunningAgentCoreToolComplete,
  waitForRunningAgentCoreToolProgress,
  type RunningAgentCoreTool
} from './agent-core-running-tool'
import { partitionAgentCoreToolCalls } from './agent-core-tool-batches'
export {
  isAgentCoreToolCallConcurrencySafe,
  partitionAgentCoreToolCalls,
  shouldAgentCoreToolCancelSiblingsOnError
} from './agent-core-tool-batches'
import type { AgentCoreHookDefinition } from '../hooks/agent-core-hook-types'
import type {
  AgentCoreToolCall,
  AgentCoreToolDefinition,
  AgentCoreToolOrchestrationUpdate,
  AgentCoreToolRunContext
} from './agent-core-tool-types'

const DEFAULT_MAX_CONCURRENT_TOOLS = 10

// 启动一个工具调用。单独封装是为了让并发池只管理 promise，不复制执行参数。
function startTool(args: {
  call: AgentCoreToolCall
  cwd: string
  signal?: AbortSignal
  tools: readonly AgentCoreToolDefinition[]
  index: number
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}): RunningAgentCoreTool {
  return startRunningAgentCoreTool(args)
}

// 串行执行有副作用工具批次。每个工具完整结束后才允许下一个工具开始。
async function* runSerialToolBatch(args: {
  calls: readonly AgentCoreToolCall[]
  cwd: string
  hooks: readonly AgentCoreHookDefinition[]
  signal?: AbortSignal
  tools: readonly AgentCoreToolDefinition[]
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  for (const call of args.calls) {
    const blockedExecution = yield* runPreToolHooks({
      hooks: args.hooks,
      cwd: args.cwd,
      call,
      signal: args.signal
    })
    if (blockedExecution !== null) {
      yield {
        type: 'tool-complete',
        call,
        execution: blockedExecution
      }
      continue
    }
    yield {
      type: 'tool-start',
      call
    }
    const running = startTool({
      call,
      cwd: args.cwd,
      signal: args.signal,
      tools: args.tools,
      index: 0,
      requestWorkerPermission: args.requestWorkerPermission
    })
    let execution
    while (execution === undefined) {
      const update = await Promise.race([
        waitForRunningAgentCoreToolComplete(running),
        waitForRunningAgentCoreToolProgress(running)
      ])
      if (update.type === 'progress') {
        yield* emitToolProgressWithHooks({
          hooks: args.hooks,
          cwd: args.cwd,
          call,
          progress: update.progress,
          signal: args.signal
        })
        continue
      }
      for (const progress of update.queuedProgress) {
        yield* emitToolProgressWithHooks({
          hooks: args.hooks,
          cwd: args.cwd,
          call,
          progress,
          signal: args.signal
        })
      }
      execution = update.execution
    }
    yield* runPermissionGateHooks({
      hooks: args.hooks,
      cwd: args.cwd,
      call,
      execution,
      signal: args.signal
    })
    yield {
      type: 'tool-complete',
      call,
      execution
    }
    yield* runToolCompletionHooks({
      hooks: args.hooks,
      cwd: args.cwd,
      call,
      execution,
      signal: args.signal
    })
  }
}

// 按读写风险编排工具：连续只读工具并发，写操作和未知工具串行。
export async function* runAgentCoreToolCalls(args: {
  calls: readonly AgentCoreToolCall[]
  cwd: string
  hooks?: readonly AgentCoreHookDefinition[]
  signal?: AbortSignal
  tools: readonly AgentCoreToolDefinition[]
  maxConcurrency?: number
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  const maxConcurrency = args.maxConcurrency ?? DEFAULT_MAX_CONCURRENT_TOOLS
  const hooks = args.hooks ?? []

  for (const batch of partitionAgentCoreToolCalls(args.calls, args.tools)) {
    const updates = batch.isConcurrencySafe
      ? runConcurrentAgentCoreToolBatch({
          calls: batch.calls,
          cwd: args.cwd,
          hooks,
          signal: args.signal,
          tools: args.tools,
          maxConcurrency,
          requestWorkerPermission: args.requestWorkerPermission
        })
      : runSerialToolBatch({
          calls: batch.calls,
          cwd: args.cwd,
          hooks,
          signal: args.signal,
          tools: args.tools,
          requestWorkerPermission: args.requestWorkerPermission
        })
    yield* updates
  }
}
