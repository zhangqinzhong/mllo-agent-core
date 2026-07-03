import { AgentCoreJsonlSessionStore } from '../session/agent-core-jsonl-session-store'
import {
  findAgentCoreTranscriptPath,
  getAgentCoreProjectDir
} from '../session/agent-core-session-paths'
import { MlloStateStore } from '../runtime-state/mllo-state-store'
import type { AgentCoreSessionHandle } from '../session/agent-core-session-types'

export type AgentCoreRunSessionOptions = {
  store?: AgentCoreJsonlSessionStore
  stateStore?: MlloStateStore
  handle?: AgentCoreSessionHandle
  sessionId?: string
  resume?: boolean
  maxIndexedResumeEntries?: number
  maxIndexedResumeBytes?: number
  configDir: string
  stateDbPath?: string
}

export type AgentCorePreparedRunSession = {
  store: AgentCoreJsonlSessionStore
  handle: AgentCoreSessionHandle
  stateStore: MlloStateStore
  ownsStateStore: boolean
  configDir: string
}

// 按 sessionId 还原 handle。resume 不能重新写 metadata，否则会污染 append-only transcript。
function createResumedSessionHandle(args: {
  cwd: string
  sessionId: string
  configDir: string
  transcriptPath?: string
}): AgentCoreSessionHandle {
  return {
    sessionId: args.sessionId,
    cwd: args.cwd,
    projectDir: getAgentCoreProjectDir(args.cwd, args.configDir),
    transcriptPath:
      args.transcriptPath ??
      findAgentCoreTranscriptPath({
        cwd: args.cwd,
        sessionId: args.sessionId,
        configDir: args.configDir
      })
  }
}

// 打开 state store。core 不猜默认路径，避免嵌入方和独立 runtime 写到不同状态库。
function prepareStateStore(session: AgentCoreRunSessionOptions): {
  stateStore: MlloStateStore
  ownsStateStore: boolean
} {
  if (session.stateStore !== undefined) {
    return {
      stateStore: session.stateStore,
      ownsStateStore: false
    }
  }
  if (session.stateDbPath === undefined) {
    throw new Error('mllo session.stateDbPath is required when stateStore is not provided.')
  }
  return {
    stateStore: new MlloStateStore({
      dbPath: session.stateDbPath
    }),
    ownsStateStore: true
  }
}

// 准备 JSONL session。新建会写 metadata，恢复只绑定已有 transcript 路径。
export async function prepareRunSession(args: {
  cwd: string
  workspaceRoots: string[]
  session: AgentCoreRunSessionOptions
}): Promise<AgentCorePreparedRunSession> {
  const state = prepareStateStore(args.session)
  const store =
    args.session.store ??
    new AgentCoreJsonlSessionStore({
      configDir: args.session.configDir
    })
  if (args.session.handle !== undefined) {
    return {
      store,
      handle: args.session.handle,
      configDir: args.session.configDir,
      ...state
    }
  }
  if (args.session.resume === true && args.session.sessionId !== undefined) {
    const existingThread = state.stateStore.getThread(args.session.sessionId)
    return {
      store,
      handle: createResumedSessionHandle({
        cwd: args.cwd,
        sessionId: args.session.sessionId,
        configDir: args.session.configDir,
        transcriptPath: existingThread?.rolloutPath
      }),
      configDir: args.session.configDir,
      ...state
    }
  }
  return {
    store,
    handle: await store.createSession({
      sessionId: args.session.sessionId,
      cwd: args.cwd,
      workspaceRoots: args.workspaceRoots
    }),
    configDir: args.session.configDir,
    ...state
  }
}
