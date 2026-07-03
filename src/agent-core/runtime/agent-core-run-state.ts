import type { AgentCoreHttpModelConfig } from '../model/agent-core-http-model-config'
import type {
  AgentCoreMessage,
  AgentCoreQueryLoopResult
} from '../query-loop/agent-core-query-types'
import type {
  AgentCoreSessionHandle,
  AgentCoreThreadRunStatus
} from '../session/agent-core-session-types'
import type { MlloStateStore } from '../runtime-state/mllo-state-store'
import type { MlloThreadRecord } from '../runtime-state/mllo-thread-records'

type SyncRunThreadStateArgs = {
  stateStore: MlloStateStore
  session: AgentCoreSessionHandle
  input: string
  provider: AgentCoreHttpModelConfig
  permissionMode: string
  sandboxPolicy: string
  estimatedInputTokens?: number
  resumeOmittedEntries: number
  resumeOmittedBytes: number
  result?: AgentCoreQueryLoopResult
}

// 集中取当前时间，后续接 deterministic clock 时只需要替换这一处。
function nowMs(): number {
  return Date.now()
}

// 把标题和预览压成单行，避免 GUI 列表被换行内容撑乱。
function compactSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

// 用用户首轮输入生成默认标题，后续标题生成器可以覆盖 state.sqlite 里的 title。
function createThreadTitle(input: string): string {
  const title = compactSingleLine(input).slice(0, 80)
  return title.length === 0 ? 'New mllo thread' : title
}

// 当前 message 只有文本内容，单独封装是为了后续兼容多模态 content。
function getMessageText(message: AgentCoreMessage): string {
  return message.content
}

// 优先用最后一条 assistant 消息作为列表预览，尚未回复时显示用户输入。
function createThreadPreview(args: { input: string; result?: AgentCoreQueryLoopResult }): string {
  const messages = args.result?.messages ?? []
  const lastAssistantText = [...messages]
    .reverse()
    .filter((message) => message.role === 'assistant')
    .map((message) => compactSingleLine(getMessageText(message)))
    .find((text) => text.length > 0)
  return (lastAssistantText ?? compactSingleLine(args.input)).slice(0, 240)
}

function resultRunStatus(result: AgentCoreQueryLoopResult | undefined): AgentCoreThreadRunStatus {
  return result?.status ?? 'running'
}

function resultRunMessage(result: AgentCoreQueryLoopResult | undefined): string | undefined {
  if (result === undefined || result.status === 'completed') {
    return undefined
  }
  if (result.status === 'error') {
    return result.message
  }
  if (result.status === 'stopped') {
    return result.reason
  }
  if (result.status === 'denied' || result.status === 'waiting-for-permission') {
    return `${result.call.name}: ${result.decision.reason}`
  }
  return `${result.call.name}: ${result.request.question}`
}

// 组装 thread 当前状态；createdAt/title/archive 保留已有值，避免 resume 覆盖用户整理过的列表。
function createThreadRecord(args: SyncRunThreadStateArgs): MlloThreadRecord {
  const existing = args.stateStore.getThread(args.session.sessionId)
  const createdAtMs = existing?.createdAtMs ?? nowMs()
  return {
    id: args.session.sessionId,
    rolloutPath: args.session.transcriptPath,
    cwd: args.session.cwd,
    title: existing?.title ?? createThreadTitle(args.input),
    modelProvider: args.provider.name ?? args.provider.protocol,
    model: args.provider.model,
    approvalMode: args.permissionMode,
    sandboxPolicy: args.sandboxPolicy,
    tokensUsed: args.estimatedInputTokens ?? existing?.tokensUsed ?? 0,
    resumeOmittedEntries: args.resumeOmittedEntries,
    resumeOmittedBytes: args.resumeOmittedBytes,
    runStatus: resultRunStatus(args.result),
    runMessage: resultRunMessage(args.result),
    archived: existing?.archived ?? false,
    preview: createThreadPreview({
      input: args.input,
      result: args.result
    }),
    createdAtMs,
    updatedAtMs: nowMs()
  }
}

// 同步 run 的 thread 当前状态到 state.sqlite，JSONL 仍然负责保存完整事实流。
export function syncAgentCoreRunThreadState(args: SyncRunThreadStateArgs): MlloThreadRecord {
  return args.stateStore.upsertThread(createThreadRecord(args))
}
