import { runPermissionGateHooks, runToolCompletionHooks } from './agent-core-tool-completion-hooks'
import { runPreToolHooks } from './agent-core-tool-hook-step'
import { emitToolProgressWithHooks } from './agent-core-tool-progress-hooks'
import {
  startRunningAgentCoreTool,
  waitForRunningAgentCoreToolComplete,
  waitForRunningAgentCoreToolProgress,
  type RunningAgentCoreTool,
  type RunningAgentCoreToolUpdate
} from './agent-core-running-tool'
import { shouldAgentCoreToolCancelSiblingsOnError } from './agent-core-tool-batches'
import type { AgentCoreHookDefinition } from '../hooks/agent-core-hook-types'
import type {
  AgentCoreToolCall,
  AgentCoreToolDefinition,
  AgentCoreToolExecutionResult,
  AgentCoreToolOrchestrationUpdate,
  AgentCoreToolRunContext
} from './agent-core-tool-types'

type CompletedRunningAgentCoreToolUpdate = Extract<RunningAgentCoreToolUpdate, { type: 'complete' }>

function startConcurrentTool(args: {
  call: AgentCoreToolCall
  cwd: string
  signal?: AbortSignal
  tools: readonly AgentCoreToolDefinition[]
  index: number
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}): RunningAgentCoreTool {
  return startRunningAgentCoreTool(args)
}

function isFailedToolExecution(execution: AgentCoreToolExecutionResult): boolean {
  switch (execution.status) {
    case 'ok':
      return execution.result.isError === true
    case 'not-found':
    case 'permission-denied':
      return true
    case 'permission-required':
      return false
  }
}

function createSiblingCancelledExecution(args: {
  call: AgentCoreToolCall
  failedCall: AgentCoreToolCall
}): AgentCoreToolExecutionResult {
  return {
    status: 'ok',
    result: {
      content: `Cancelled ${args.call.name} because parallel tool call ${args.failedCall.name} failed.`,
      isError: true,
      errorKind: 'cancelled-sibling'
    }
  }
}

async function* startInitialConcurrentTools(args: {
  calls: readonly AgentCoreToolCall[]
  cwd: string
  hooks: readonly AgentCoreHookDefinition[]
  maxConcurrency: number
  nextIndex: number
  running: RunningAgentCoreTool[]
  signal?: AbortSignal
  tools: readonly AgentCoreToolDefinition[]
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, number> {
  let nextIndex = args.nextIndex
  while (nextIndex < args.calls.length && args.running.length < args.maxConcurrency) {
    nextIndex = yield* maybeStartConcurrentTool({
      ...args,
      nextIndex
    })
  }
  return nextIndex
}

async function* maybeStartConcurrentTool(args: {
  calls: readonly AgentCoreToolCall[]
  cwd: string
  hooks: readonly AgentCoreHookDefinition[]
  nextIndex: number
  running: RunningAgentCoreTool[]
  signal?: AbortSignal
  tools: readonly AgentCoreToolDefinition[]
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, number> {
  const call = args.calls[args.nextIndex]!
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
    return args.nextIndex + 1
  }
  yield {
    type: 'tool-start',
    call
  }
  args.running.push(
    startConcurrentTool({
      call,
      cwd: args.cwd,
      signal: args.signal,
      tools: args.tools,
      index: args.nextIndex,
      requestWorkerPermission: args.requestWorkerPermission
    })
  )
  return args.nextIndex + 1
}

async function* emitConcurrentCompletion(args: {
  cwd: string
  hooks: readonly AgentCoreHookDefinition[]
  update: CompletedRunningAgentCoreToolUpdate
  signal?: AbortSignal
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  for (const progress of args.update.queuedProgress) {
    yield* emitToolProgressWithHooks({
      hooks: args.hooks,
      cwd: args.cwd,
      call: args.update.running.call,
      progress,
      signal: args.signal
    })
  }
  yield* runPermissionGateHooks({
    hooks: args.hooks,
    cwd: args.cwd,
    call: args.update.running.call,
    execution: args.update.execution,
    signal: args.signal
  })
  yield {
    type: 'tool-complete',
    call: args.update.running.call,
    execution: args.update.execution
  }
  yield* runToolCompletionHooks({
    hooks: args.hooks,
    cwd: args.cwd,
    call: args.update.running.call,
    execution: args.update.execution,
    signal: args.signal
  })
}

// 并发执行只读工具批次。shell 失败时会取消同批兄弟工具并补齐未启动结果。
export async function* runConcurrentAgentCoreToolBatch(args: {
  calls: readonly AgentCoreToolCall[]
  cwd: string
  hooks: readonly AgentCoreHookDefinition[]
  signal?: AbortSignal
  tools: readonly AgentCoreToolDefinition[]
  maxConcurrency: number
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  const running: RunningAgentCoreTool[] = []
  let nextIndex = yield* startInitialConcurrentTools({
    ...args,
    nextIndex: 0,
    running
  })
  let failedCancellationCall: AgentCoreToolCall | undefined

  while (running.length > 0) {
    const update = await Promise.race([
      ...running.map(waitForRunningAgentCoreToolComplete),
      ...running.map(waitForRunningAgentCoreToolProgress)
    ])
    if (update.type === 'progress') {
      yield* emitToolProgressWithHooks({
        hooks: args.hooks,
        cwd: args.cwd,
        call: update.running.call,
        progress: update.progress,
        signal: args.signal
      })
      continue
    }

    const completedIndex = running.findIndex((item) => item.index === update.running.index)
    if (completedIndex >= 0) {
      running.splice(completedIndex, 1)
    }
    yield* emitConcurrentCompletion({
      cwd: args.cwd,
      hooks: args.hooks,
      update,
      signal: args.signal
    })

    if (
      failedCancellationCall === undefined &&
      isFailedToolExecution(update.execution) &&
      shouldAgentCoreToolCancelSiblingsOnError(args.tools, update.running.call)
    ) {
      failedCancellationCall = update.running.call
      // 同批工具的 sibling cancellation，避免 shell 失败后同批命令继续制造噪声。
      for (const runningTool of running) {
        runningTool.abort('sibling-tool-error')
      }
    }

    if (failedCancellationCall === undefined && nextIndex < args.calls.length) {
      nextIndex = yield* maybeStartConcurrentTool({
        ...args,
        nextIndex,
        running
      })
    }
  }

  if (failedCancellationCall !== undefined) {
    for (const call of args.calls.slice(nextIndex)) {
      yield {
        type: 'tool-complete',
        call,
        execution: createSiblingCancelledExecution({
          call,
          failedCall: failedCancellationCall
        })
      }
    }
  }
}
