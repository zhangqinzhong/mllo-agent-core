import { createAgentCoreProgressQueue } from './agent-core-progress-queue'
import { runAgentCoreToolCall } from './agent-core-tool-runner'
import type {
  AgentCoreToolCall,
  AgentCoreToolDefinition,
  AgentCoreToolExecutionResult,
  AgentCoreToolProgress
} from './agent-core-tool-types'

export type RunningAgentCoreTool = {
  index: number
  call: AgentCoreToolCall
  abort: (reason: string) => void
  promise: Promise<AgentCoreToolExecutionResult>
  nextProgress: () => Promise<AgentCoreToolProgress | null>
  pendingProgressPromise?: Promise<AgentCoreToolProgress | null>
  pendingCompletePromise?: Promise<RunningAgentCoreToolUpdate>
}

export type RunningAgentCoreToolUpdate =
  | {
      type: 'complete'
      running: RunningAgentCoreTool
      execution: AgentCoreToolExecutionResult
      queuedProgress: AgentCoreToolProgress[]
    }
  | {
      type: 'progress'
      running: RunningAgentCoreTool
      progress: AgentCoreToolProgress
    }

// 启动一个工具调用并绑定进度队列。工具回调推 progress，编排层统一转成 timeline。
export function startRunningAgentCoreTool(args: {
  call: AgentCoreToolCall
  cwd: string
  signal?: AbortSignal
  tools: readonly AgentCoreToolDefinition[]
  index: number
  permissionOverride?: 'allow'
  requestWorkerPermission?: Parameters<typeof runAgentCoreToolCall>[0]['requestWorkerPermission']
}): RunningAgentCoreTool {
  const progressQueue = createAgentCoreProgressQueue<AgentCoreToolProgress>()
  const abortController = new AbortController()
  const abortFromParent = (): void => {
    abortController.abort(args.signal?.reason ?? 'parent-abort')
  }
  if (args.signal?.aborted === true) {
    abortFromParent()
  } else {
    args.signal?.addEventListener('abort', abortFromParent, {
      once: true
    })
  }
  const promise = runAgentCoreToolCall({
    call: args.call,
    cwd: args.cwd,
    signal: abortController.signal,
    tools: args.tools,
    permissionOverride: args.permissionOverride,
    requestWorkerPermission: args.requestWorkerPermission,
    onProgress: (progress) => {
      progressQueue.push(progress)
    }
  }).finally(() => {
    args.signal?.removeEventListener('abort', abortFromParent)
    progressQueue.close()
  })

  return {
    index: args.index,
    call: args.call,
    abort(reason) {
      abortController.abort(reason)
    },
    promise,
    nextProgress: progressQueue.next
  }
}

// 真正等待工具完成并 drain 剩余 progress。调用方应该通过缓存入口复用它。
async function waitForRunningAgentCoreToolCompleteOnce(
  running: RunningAgentCoreTool
): Promise<RunningAgentCoreToolUpdate> {
  const execution = await running.promise
  const queuedProgress: AgentCoreToolProgress[] = []
  const pendingProgress = running.pendingProgressPromise
  if (pendingProgress !== undefined) {
    const progress = await pendingProgress
    if (progress !== null) {
      queuedProgress.push(progress)
    }
  }
  while (true) {
    const progress = await running.nextProgress()
    if (progress === null) {
      break
    }
    queuedProgress.push(progress)
  }
  return {
    type: 'complete',
    running,
    execution,
    queuedProgress
  }
}

// 等待工具完成事件。complete waiter 只能创建一次，避免多个 waiter 竞争 drain progress 队列。
export async function waitForRunningAgentCoreToolComplete(
  running: RunningAgentCoreTool
): Promise<RunningAgentCoreToolUpdate> {
  running.pendingCompletePromise ??= waitForRunningAgentCoreToolCompleteOnce(running)
  return await running.pendingCompletePromise
}

// 等待工具下一条进度。队列关闭时返回一个永不结束的 promise，避免干扰 Promise.race。
export async function waitForRunningAgentCoreToolProgress(
  running: RunningAgentCoreTool
): Promise<RunningAgentCoreToolUpdate> {
  running.pendingProgressPromise ??= running.nextProgress()
  const progress = await running.pendingProgressPromise.finally(() => {
    running.pendingProgressPromise = undefined
  })
  if (progress === null) {
    return await new Promise<RunningAgentCoreToolUpdate>(() => {})
  }
  return {
    type: 'progress',
    running,
    progress
  }
}
