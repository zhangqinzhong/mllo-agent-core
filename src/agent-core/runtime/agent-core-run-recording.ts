import { appendAgentCoreFileHistoryEntry } from '../session/agent-core-file-history'
import { createAgentCoreWorkerToolResultEventEntry } from '../session/agent-core-worker-tool-result-event-entry'
import type { AgentCoreMessage, AgentCoreQueryEvent } from '../query-loop/agent-core-query-types'
import type { AgentCoreWorker } from '../workers/agent-core-worker-types'
import { writeAgentCoreWorkerToolResultBlob } from '../workers/agent-core-worker-tool-result-blob-store'
import {
  limitAgentCoreWorkerToolResultOutput,
  serializeAgentCoreWorkerToolResultOutput
} from '../workers/agent-core-worker-tool-result-budget'
import type { AgentCorePreparedRunSession } from './agent-core-run-session'
import type { MlloThreadRecord } from '../runtime-state/mllo-thread-records'
import { syncAgentCoreRunProgressState } from './agent-core-run-state-events'
import {
  redactAgentCoreEventInput,
  redactAgentCoreMessageInput
} from './agent-core-permission-input-redaction'

function entryTimestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

async function limitWorkerToolResultProgressEvent(args: {
  session: AgentCorePreparedRunSession
  event: AgentCoreQueryEvent
}): Promise<AgentCoreQueryEvent> {
  const event = args.event
  if (event.type !== 'tool-progress' || event.progress.kind !== 'worker-event') {
    return event
  }
  if (event.progress.event.type !== 'tool-result') {
    return event
  }
  const limitedEvent = limitAgentCoreWorkerToolResultOutput(event.progress.event)
  if (limitedEvent.outputTruncated !== true || limitedEvent.outputBlobPath !== undefined) {
    return {
      ...event,
      progress: {
        kind: 'worker-event',
        event: limitedEvent
      }
    }
  }
  const fullOutput = serializeAgentCoreWorkerToolResultOutput(event.progress.event.output)
  const blob = await writeAgentCoreWorkerToolResultBlob({
    projectDir: args.session.handle.projectDir,
    sessionId: args.session.handle.sessionId,
    cwd: args.session.handle.cwd,
    workerId: event.progress.event.workerId,
    ...(event.progress.event.invocationId === undefined
      ? {}
      : { invocationId: event.progress.event.invocationId }),
    toolName: event.progress.event.name,
    content: fullOutput
  })
  return {
    ...event,
    progress: {
      kind: 'worker-event',
      event: {
        ...limitedEvent,
        outputBlobPath: blob.relativePath,
        outputBlobBytes: blob.byteLength
      }
    }
  }
}

// 把 timeline event 写进 JSONL。controller 自己管理 resume，因此不能只靠 recordedQueryLoop。
async function recordTimelineEvent(args: {
  session: AgentCorePreparedRunSession
  event: AgentCoreQueryEvent
}): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createTimelineEventEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      event: args.event
    })
  )
}

// hook 事件既进入 timeline，也进入专门的 hook entry，方便后续审计。
async function recordHookEvent(args: {
  session: AgentCorePreparedRunSession
  event: Extract<AgentCoreQueryEvent, { type: 'hook-event' }>
}): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createHookEventEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      hookName: args.event.hookName,
      phase: args.event.phase,
      status: args.event.status,
      content: args.event.content
    })
  )
}

// worker 内部工具调用要独立审计；timeline 负责展示，worker-tool-event 负责追责。
async function recordWorkerToolEvent(args: {
  session: AgentCorePreparedRunSession
  event: Extract<AgentCoreQueryEvent, { type: 'tool-progress' }>
}): Promise<void> {
  const progress = args.event.progress
  if (progress.kind !== 'worker-event' || progress.event.type !== 'tool-use') {
    return
  }
  const entry = args.session.store.createWorkerToolEventEntry({
    sessionId: args.session.handle.sessionId,
    cwd: args.session.handle.cwd,
    tool: {
      workerId: progress.event.workerId,
      ...(progress.event.invocationId === undefined
        ? {}
        : { invocationId: progress.event.invocationId }),
      name: progress.event.name,
      input: progress.event.input
    }
  })
  await args.session.store.appendEntry(args.session.handle, entry)
  args.session.stateStore.upsertWorkerToolEvent({
    id: entry.uuid,
    threadId: args.session.handle.sessionId,
    kind: 'use',
    workerId: entry.tool.workerId,
    ...(entry.tool.invocationId === undefined ? {} : { invocationId: entry.tool.invocationId }),
    toolName: entry.tool.name,
    payload: entry.tool.input,
    createdAtMs: entryTimestampMs(entry.timestamp)
  })
}

// worker 工具结果和工具开始分开落盘，避免审计时把 begin/result 混成一条事实。
async function recordWorkerToolResultEvent(args: {
  session: AgentCorePreparedRunSession
  event: Extract<AgentCoreQueryEvent, { type: 'tool-progress' }>
}): Promise<void> {
  const progress = args.event.progress
  if (progress.kind !== 'worker-event' || progress.event.type !== 'tool-result') {
    return
  }
  const entry = createAgentCoreWorkerToolResultEventEntry({
    sessionId: args.session.handle.sessionId,
    cwd: args.session.handle.cwd,
    result: {
      workerId: progress.event.workerId,
      ...(progress.event.invocationId === undefined
        ? {}
        : { invocationId: progress.event.invocationId }),
      name: progress.event.name,
      output: progress.event.output,
      ...(progress.event.isError === undefined ? {} : { isError: progress.event.isError }),
      ...(progress.event.outputTruncated === undefined
        ? {}
        : { outputTruncated: progress.event.outputTruncated }),
      ...(progress.event.outputOriginalChars === undefined
        ? {}
        : { outputOriginalChars: progress.event.outputOriginalChars }),
      ...(progress.event.outputMaxChars === undefined
        ? {}
        : { outputMaxChars: progress.event.outputMaxChars }),
      ...(progress.event.outputBlobPath === undefined
        ? {}
        : { outputBlobPath: progress.event.outputBlobPath }),
      ...(progress.event.outputBlobBytes === undefined
        ? {}
        : { outputBlobBytes: progress.event.outputBlobBytes })
    }
  })
  await args.session.store.appendEntry(args.session.handle, entry)
  args.session.stateStore.upsertWorkerToolEvent({
    id: entry.uuid,
    threadId: args.session.handle.sessionId,
    kind: 'result',
    workerId: entry.result.workerId,
    ...(entry.result.invocationId === undefined ? {} : { invocationId: entry.result.invocationId }),
    toolName: entry.result.name,
    payload: entry.result.output,
    ...(entry.result.isError === undefined ? {} : { isError: entry.result.isError }),
    ...(entry.result.outputTruncated === undefined
      ? {}
      : { payloadTruncated: entry.result.outputTruncated }),
    ...(entry.result.outputOriginalChars === undefined
      ? {}
      : { payloadOriginalChars: entry.result.outputOriginalChars }),
    ...(entry.result.outputMaxChars === undefined
      ? {}
      : { payloadMaxChars: entry.result.outputMaxChars }),
    ...(entry.result.outputBlobPath === undefined
      ? {}
      : { payloadBlobPath: entry.result.outputBlobPath }),
    ...(entry.result.outputBlobBytes === undefined
      ? {}
      : { payloadBlobBytes: entry.result.outputBlobBytes }),
    createdAtMs: entryTimestampMs(entry.timestamp)
  })
}

// 记录一次事件并继续 yield 给 UI。持久化和展示必须保持同一事件序列。
export async function recordAgentCoreRunEvent(args: {
  session: AgentCorePreparedRunSession
  event: AgentCoreQueryEvent
  workers: readonly AgentCoreWorker[]
}): Promise<AgentCoreQueryEvent> {
  const event = await limitWorkerToolResultProgressEvent({
    session: args.session,
    event: redactAgentCoreEventInput(args.event)
  })
  syncAgentCoreRunProgressState({
    stateStore: args.session.stateStore,
    threadId: args.session.handle.sessionId,
    cwd: args.session.handle.cwd,
    event,
    workers: args.workers
  })
  if (event.type === 'hook-event') {
    await recordHookEvent({
      session: args.session,
      event
    })
  }
  if (event.type === 'tool-progress' && event.progress.kind === 'file-change') {
    await appendAgentCoreFileHistoryEntry({
      configDir: args.session.configDir,
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      change: event.progress.change
    })
  }
  if (event.type === 'tool-progress') {
    await recordWorkerToolEvent({
      session: args.session,
      event
    })
    await recordWorkerToolResultEvent({
      session: args.session,
      event
    })
  }
  await recordTimelineEvent({
    session: args.session,
    event
  })
  return event
}

// 只追加尚未持久化的 message。权限暂停/compact 后恢复都依赖 JSONL 里有完整模型链。
export async function recordAgentCoreRunMessagesFrom(args: {
  session: AgentCorePreparedRunSession
  messages: readonly AgentCoreMessage[]
  startIndex: number
}): Promise<number> {
  for (const message of args.messages.slice(args.startIndex).map(redactAgentCoreMessageInput)) {
    await args.session.store.appendMessage(
      args.session.handle,
      args.session.store.createMessageEntry({
        sessionId: args.session.handle.sessionId,
        cwd: args.session.handle.cwd,
        message
      })
    )
  }
  return args.messages.length
}

// 记录 thread 当前态快照。state.sqlite 是派生索引，reindex 需要从 JSONL 找回这些字段。
export async function recordAgentCoreThreadStateSnapshot(args: {
  session: AgentCorePreparedRunSession
  thread: MlloThreadRecord
}): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createThreadStateEventEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      snapshot: args.thread
    })
  )
}
