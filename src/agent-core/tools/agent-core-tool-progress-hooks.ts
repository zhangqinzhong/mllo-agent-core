import { runAgentCoreHooks } from '../hooks/agent-core-hook-runner'
import type { AgentCoreHookDefinition } from '../hooks/agent-core-hook-types'
import type {
  AgentCoreToolCall,
  AgentCoreToolOrchestrationUpdate,
  AgentCoreToolProgress
} from './agent-core-tool-types'

// 文件变更和 cwd 变更是运行时事实，必须从 progress 流转成 hook 事件。
export async function* runToolProgressHooks(args: {
  hooks: readonly AgentCoreHookDefinition[]
  cwd: string
  call: AgentCoreToolCall
  progress: AgentCoreToolProgress
  signal?: AbortSignal
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  if (args.progress.kind === 'file-change') {
    yield* runAgentCoreHooks({
      hooks: args.hooks,
      context: {
        phase: 'file-changed',
        cwd: args.cwd,
        call: args.call,
        fileChange: args.progress.change,
        signal: args.signal
      }
    })
    return
  }

  if (args.progress.kind === 'cwd-change') {
    yield* runAgentCoreHooks({
      hooks: args.hooks,
      context: {
        phase: 'cwd-changed',
        cwd: args.cwd,
        call: args.call,
        cwdChange: args.progress.change,
        signal: args.signal
      }
    })
    return
  }

  if (args.progress.kind === 'worker-event' && args.progress.event.type === 'worker-start') {
    yield* runAgentCoreHooks({
      hooks: args.hooks,
      context: {
        phase: 'subagent-start',
        cwd: args.cwd,
        call: args.call,
        subagentEvent: args.progress.event,
        signal: args.signal
      }
    })
    return
  }

  if (
    args.progress.kind === 'worker-event' &&
    (args.progress.event.type === 'worker-done' || args.progress.event.type === 'worker-error')
  ) {
    yield* runAgentCoreHooks({
      hooks: args.hooks,
      context: {
        phase: 'subagent-end',
        cwd: args.cwd,
        call: args.call,
        subagentEvent: args.progress.event,
        signal: args.signal
      }
    })
  }
}

// 先把 progress 交给 UI，再触发事实型 hook，保证 timeline 里先出现原始变更。
export async function* emitToolProgressWithHooks(args: {
  hooks: readonly AgentCoreHookDefinition[]
  cwd: string
  call: AgentCoreToolCall
  progress: AgentCoreToolProgress
  signal?: AbortSignal
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  yield {
    type: 'tool-progress',
    call: args.call,
    progress: args.progress
  }
  yield* runToolProgressHooks(args)
}
