import { AgentCoreJsonlSessionStore } from '../session/agent-core-jsonl-session-store'
import { createAgentCoreThreadMetadataEventEntry } from '../session/agent-core-thread-metadata-entry'
import { getAgentCoreProjectDir } from '../session/agent-core-session-paths'
import type { AgentCoreThreadMetadataPatch } from '../session/agent-core-session-types'
import type { MlloThreadRecord } from './mllo-thread-records'
import { MlloStateStore } from './mllo-state-store'

export type MlloThreadMetadataUpdateOptions = {
  configDir: string
  stateDbPath?: string
  stateStore?: MlloStateStore
  sessionStore?: AgentCoreJsonlSessionStore
}

export type MlloThreadMetadataPatchInput = {
  title?: string
  archived?: boolean
  source?: 'user' | 'system'
}

// 打开 state store。调用方传入连接时不在这里关闭，避免 UI 批处理时被提前释放。
function openMetadataStateStore(options: MlloThreadMetadataUpdateOptions): {
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

// 创建 JSONL session handle。metadata 更新只追加事件，不会重新写 session metadata。
function createThreadSessionHandle(args: {
  configDir: string
  thread: MlloThreadRecord
}): Parameters<AgentCoreJsonlSessionStore['appendEntry']>[0] {
  return {
    sessionId: args.thread.id,
    cwd: args.thread.cwd,
    projectDir: getAgentCoreProjectDir(args.thread.cwd, args.configDir),
    transcriptPath: args.thread.rolloutPath
  }
}

// 把外部 patch 补成 transcript 里的稳定 patch，显式带 updatedAt 和来源。
function createMetadataPatch(input: MlloThreadMetadataPatchInput): AgentCoreThreadMetadataPatch {
  return {
    title: input.title,
    archived: input.archived,
    updatedAtMs: Date.now(),
    source: input.source ?? 'user'
  }
}

// 把 metadata patch 应用到当前 thread。没有传的字段保持原值。
function applyMetadataPatchToThread(
  thread: MlloThreadRecord,
  patch: AgentCoreThreadMetadataPatch
): MlloThreadRecord {
  return {
    ...thread,
    title: patch.title ?? thread.title,
    archived: patch.archived ?? thread.archived,
    updatedAtMs: patch.updatedAtMs
  }
}

// 更新 thread 元数据，并把同一操作追加进 JSONL，保证 state.sqlite 可由 transcript 重建。
export async function updateMlloThreadMetadata(args: {
  threadId: string
  patch: MlloThreadMetadataPatchInput
  options: MlloThreadMetadataUpdateOptions
}): Promise<MlloThreadRecord> {
  const options = args.options
  const { stateStore, shouldClose } = openMetadataStateStore(options)
  const sessionStore =
    options.sessionStore ??
    new AgentCoreJsonlSessionStore({
      configDir: options.configDir
    })
  try {
    const existing = stateStore.getThread(args.threadId)
    if (existing === undefined) {
      throw new Error(`mllo thread not found: ${args.threadId}`)
    }
    const patch = createMetadataPatch(args.patch)
    const updated = stateStore.upsertThread(applyMetadataPatchToThread(existing, patch))
    await sessionStore.appendEntry(
      createThreadSessionHandle({
        configDir: options.configDir,
        thread: updated
      }),
      createAgentCoreThreadMetadataEventEntry({
        sessionId: updated.id,
        cwd: updated.cwd,
        patch
      })
    )
    return updated
  } finally {
    if (shouldClose) {
      stateStore.close()
    }
  }
}
