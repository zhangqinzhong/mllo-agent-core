import { AgentCoreJsonlSessionStore } from '../session/agent-core-jsonl-session-store'
import { readAgentCoreSessionIndex } from '../session/agent-core-session-index'
import type { AgentCoreSessionEntry } from '../session/agent-core-session-types'
import { syncAgentCoreRunProgressState } from '../runtime/agent-core-run-state-events'
import { MlloStateStore } from './mllo-state-store'
import {
  applyMlloBudgetToThreadDraft,
  applyMlloMessageToThreadDraft,
  applyMlloThreadMetadataPatch,
  applyMlloThreadStateSnapshot,
  createMlloReindexThreadDraft,
  mlloThreadDraftToRecord,
  parseMlloReindexTimestampMs
} from './mllo-state-reindex-thread-draft'

export type MlloStateReindexOptions = {
  configDir: string
  stateDbPath?: string
  stateStore?: MlloStateStore
  sessionIds?: readonly string[]
  reset?: boolean
}

export type MlloStateReindexResult = {
  sessionsSeen: number
  indexedThreads: number
  indexedThreadEdges: number
  indexedTasks: number
  indexedTeamMembers: number
  indexedCheckpointRestores: number
  indexedWorkerToolEvents: number
  skippedSessions: {
    sessionId: string
    reason: string
  }[]
}

function indexWorkerToolEvent(args: {
  stateStore: MlloStateStore
  entry: Extract<AgentCoreSessionEntry, { kind: 'worker-tool-event' | 'worker-tool-result-event' }>
}): void {
  if (args.entry.kind === 'worker-tool-event') {
    args.stateStore.upsertWorkerToolEvent({
      id: args.entry.uuid,
      threadId: args.entry.sessionId,
      kind: 'use',
      workerId: args.entry.tool.workerId,
      ...(args.entry.tool.invocationId === undefined
        ? {}
        : { invocationId: args.entry.tool.invocationId }),
      toolName: args.entry.tool.name,
      payload: args.entry.tool.input,
      createdAtMs: parseMlloReindexTimestampMs(args.entry.timestamp)
    })
    return
  }
  args.stateStore.upsertWorkerToolEvent({
    id: args.entry.uuid,
    threadId: args.entry.sessionId,
    kind: 'result',
    workerId: args.entry.result.workerId,
    ...(args.entry.result.invocationId === undefined
      ? {}
      : { invocationId: args.entry.result.invocationId }),
    toolName: args.entry.result.name,
    payload: args.entry.result.output,
    isError: args.entry.result.isError ?? false,
    ...(args.entry.result.outputTruncated === undefined
      ? {}
      : { payloadTruncated: args.entry.result.outputTruncated }),
    ...(args.entry.result.outputOriginalChars === undefined
      ? {}
      : { payloadOriginalChars: args.entry.result.outputOriginalChars }),
    ...(args.entry.result.outputMaxChars === undefined
      ? {}
      : { payloadMaxChars: args.entry.result.outputMaxChars }),
    ...(args.entry.result.outputBlobPath === undefined
      ? {}
      : { payloadBlobPath: args.entry.result.outputBlobPath }),
    ...(args.entry.result.outputBlobBytes === undefined
      ? {}
      : { payloadBlobBytes: args.entry.result.outputBlobBytes }),
    createdAtMs: parseMlloReindexTimestampMs(args.entry.timestamp)
  })
}

function indexCheckpointRestoreEvent(args: {
  stateStore: MlloStateStore
  entry: Extract<AgentCoreSessionEntry, { kind: 'checkpoint-restore-event' }>
}): void {
  const restoredCount = args.entry.restore.files.filter((file) => file.action === 'restored').length
  const deletedCount = args.entry.restore.files.filter((file) => file.action === 'deleted').length
  const conflictCount = args.entry.restore.files.filter((file) => file.action === 'conflict').length
  args.stateStore.upsertCheckpointRestore(
    {
      id: args.entry.uuid,
      threadId: args.entry.sessionId,
      checkpointId: args.entry.restore.checkpointId,
      checkpointPath: args.entry.restore.checkpointPath,
      conflictStrategy: args.entry.restore.conflictStrategy,
      requestedFilePaths: args.entry.restore.requestedFilePaths ?? [],
      restoredCount,
      deletedCount,
      conflictCount,
      createdAtMs: parseMlloReindexTimestampMs(args.entry.timestamp)
    },
    args.entry.restore.files.map((file) => {
      const record = {
        restoreId: args.entry.uuid,
        path: file.path,
        resolvedPath: file.resolvedPath,
        action: file.action
      }
      return {
        ...record,
        ...(file.reason !== undefined ? { reason: file.reason } : {}),
        ...(file.restoredAt !== undefined ? { restoredAt: file.restoredAt } : {})
      }
    })
  )
}

// 读取一个 transcript 并重放成 SQLite 当前态。坏 transcript 由调用方记录 skipped。
async function reindexSessionTranscript(args: {
  store: AgentCoreJsonlSessionStore
  stateStore: MlloStateStore
  transcriptPath: string
  sessionId: string
  cwd: string
}): Promise<void> {
  const entries = await args.store.readSession({
    sessionId: args.sessionId,
    cwd: args.cwd,
    projectDir: '',
    transcriptPath: args.transcriptPath
  })
  const metadata = entries.find(
    (entry): entry is Extract<AgentCoreSessionEntry, { kind: 'session-metadata' }> =>
      entry.kind === 'session-metadata'
  )
  const draft =
    metadata === undefined ? undefined : createMlloReindexThreadDraft(metadata, args.transcriptPath)
  if (draft === undefined) {
    throw new Error('session metadata entry is missing')
  }

  for (const entry of entries) {
    if (entry.kind === 'message') {
      applyMlloMessageToThreadDraft(draft, entry)
      continue
    }
    if (entry.kind === 'budget-event') {
      applyMlloBudgetToThreadDraft(draft, entry)
      continue
    }
    if (entry.kind === 'thread-state-event') {
      applyMlloThreadStateSnapshot(draft, entry.snapshot)
      continue
    }
    if (entry.kind === 'thread-metadata-event') {
      applyMlloThreadMetadataPatch(draft, entry)
      continue
    }
    if (entry.kind === 'thread-edge-event') {
      args.stateStore.upsertThreadEdge(entry.edge)
      draft.updatedAtMs = parseMlloReindexTimestampMs(entry.timestamp)
      continue
    }
    if (entry.kind === 'checkpoint-restore-event') {
      indexCheckpointRestoreEvent({
        stateStore: args.stateStore,
        entry
      })
      draft.updatedAtMs = parseMlloReindexTimestampMs(entry.timestamp)
      continue
    }
    if (entry.kind === 'worker-tool-event' || entry.kind === 'worker-tool-result-event') {
      indexWorkerToolEvent({
        stateStore: args.stateStore,
        entry
      })
      draft.updatedAtMs = parseMlloReindexTimestampMs(entry.timestamp)
      continue
    }
    if (entry.kind === 'timeline-event') {
      syncAgentCoreRunProgressState({
        stateStore: args.stateStore,
        threadId: args.sessionId,
        cwd: args.cwd,
        event: entry.event,
        workers: []
      })
      draft.updatedAtMs = parseMlloReindexTimestampMs(entry.timestamp)
    }
  }

  args.stateStore.upsertThread(mlloThreadDraftToRecord(draft))
}

// 打开 state store。调用方传入 store 时不由 reindex 关闭，避免测试和批处理复用连接被误关。
function openReindexStateStore(options: MlloStateReindexOptions): {
  stateStore: MlloStateStore
  shouldClose: boolean
} {
  if (options.stateStore !== undefined) {
    return {
      stateStore: options.stateStore,
      shouldClose: false
    }
  }
  if (options.stateDbPath === undefined) {
    throw new Error('mllo stateDbPath is required when stateStore is not provided.')
  }
  return {
    stateStore: new MlloStateStore({
      dbPath: options.stateDbPath
    }),
    shouldClose: true
  }
}

// 从 session index 重建 mllo state.sqlite。JSONL 是事实来源，SQLite 只是可再生索引。
export async function reindexMlloState(
  options: MlloStateReindexOptions
): Promise<MlloStateReindexResult> {
  const { stateStore, shouldClose } = openReindexStateStore(options)
  const sessionIds = new Set(options.sessionIds ?? [])
  const sessionStore = new AgentCoreJsonlSessionStore({
    configDir: options.configDir
  })
  const result: MlloStateReindexResult = {
    sessionsSeen: 0,
    indexedThreads: 0,
    indexedThreadEdges: 0,
    indexedTasks: 0,
    indexedTeamMembers: 0,
    indexedCheckpointRestores: 0,
    indexedWorkerToolEvents: 0,
    skippedSessions: []
  }

  try {
    if (options.reset === true) {
      stateStore.clearDerivedState()
    }
    const sessionIndex = await readAgentCoreSessionIndex(options.configDir)
    for (const session of sessionIndex) {
      if (sessionIds.size > 0 && !sessionIds.has(session.sessionId)) {
        continue
      }
      result.sessionsSeen += 1
      try {
        await reindexSessionTranscript({
          store: sessionStore,
          stateStore,
          transcriptPath: session.transcriptPath,
          sessionId: session.sessionId,
          cwd: session.cwd
        })
        result.indexedThreads += 1
      } catch (error) {
        result.skippedSessions.push({
          sessionId: session.sessionId,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    result.indexedTasks = sessionIndex
      .filter((session) => sessionIds.size === 0 || sessionIds.has(session.sessionId))
      .reduce(
        (count, session) => count + stateStore.listTasksForThread(session.sessionId).length,
        0
      )
    result.indexedThreadEdges = sessionIndex
      .filter((session) => sessionIds.size === 0 || sessionIds.has(session.sessionId))
      .reduce((count, session) => count + stateStore.listThreadEdges(session.sessionId).length, 0)
    result.indexedTeamMembers = sessionIndex
      .filter((session) => sessionIds.size === 0 || sessionIds.has(session.sessionId))
      .reduce((count, session) => count + stateStore.listTeamMembers(session.sessionId).length, 0)
    result.indexedCheckpointRestores = sessionIndex
      .filter((session) => sessionIds.size === 0 || sessionIds.has(session.sessionId))
      .reduce(
        (count, session) =>
          count + stateStore.listCheckpointRestoresForThread(session.sessionId).length,
        0
      )
    result.indexedWorkerToolEvents = sessionIndex
      .filter((session) => sessionIds.size === 0 || sessionIds.has(session.sessionId))
      .reduce(
        (count, session) =>
          count + stateStore.listWorkerToolEventsForThread(session.sessionId).length,
        0
      )
    return result
  } finally {
    if (shouldClose) {
      stateStore.close()
    }
  }
}
