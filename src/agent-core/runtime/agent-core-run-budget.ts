import { applyAgentCoreBudget } from '../budget/agent-core-budget-engine'
import type { AgentCoreWillCompactContext } from '../budget/agent-core-budget-engine'
import type {
  AgentCoreBudgetPolicy,
  AgentCoreBudgetState,
  AgentCoreCompactRecord,
  AgentCoreSummarizer
} from '../budget/agent-core-budget-types'
import { runAgentCoreHooks } from '../hooks/agent-core-hook-runner'
import type {
  AgentCoreCompactHookContext,
  AgentCoreHookDefinition,
  AgentCoreHookEvent
} from '../hooks/agent-core-hook-types'
import type { AgentCoreMessage, AgentCoreModelAdapter } from '../query-loop/agent-core-query-types'
import type { AgentCoreJsonlSessionStore } from '../session/agent-core-jsonl-session-store'
import type { AgentCoreSessionHandle } from '../session/agent-core-session-types'
import { renderAgentCoreCompactTranscript } from '../budget/agent-core-compact-transcript'
import {
  appendAgentCoreFileChangeCompactContext,
  type AgentCoreFileChangeCompactContextPolicy
} from '../budget/agent-core-file-change-compact-context'
import { readAgentCoreFileHistory } from '../session/agent-core-file-history'
import {
  createModelMemoryExtractor,
  createModelMemoryMerger,
  recordAgentCoreSessionMemoryCompact,
  type AgentCoreMemoryExtractor,
  type AgentCoreMemoryMerger
} from './agent-core-session-memory-compact'

export type AgentCoreRunBudgetOptions = {
  policy?: Partial<AgentCoreBudgetPolicy>
  summarizer?: AgentCoreSummarizer
  memoryExtractor?: AgentCoreMemoryExtractor
  memoryMerger?: AgentCoreMemoryMerger
  memoryMergeTriggerChars?: number
  writeSessionMemory?: boolean
  fileChangeContext?: Partial<AgentCoreFileChangeCompactContextPolicy>
}

export type AgentCoreRunBudgetResult = {
  messages: AgentCoreMessage[]
  budgetState: AgentCoreBudgetState
  compacted: boolean
}

type AgentCoreRunSession = {
  store: AgentCoreJsonlSessionStore
  handle: AgentCoreSessionHandle
  configDir: string
}

type AgentCoreCompactHookOptions = {
  hooks?: readonly AgentCoreHookDefinition[]
  onHookEvent?: (event: AgentCoreHookEvent) => void | Promise<void>
  signal?: AbortSignal
}

async function runCompactHooks(args: {
  phase: 'pre-compact' | 'post-compact'
  cwd: string
  compact: AgentCoreCompactHookContext
  options?: AgentCoreCompactHookOptions
}): Promise<void> {
  const generator = runAgentCoreHooks({
    hooks: args.options?.hooks ?? [],
    context: {
      phase: args.phase,
      cwd: args.cwd,
      compact: args.compact,
      signal: args.options?.signal
    }
  })
  while (true) {
    const item = await generator.next()
    if (item.done === true) {
      if (args.phase === 'pre-compact' && item.value.action === 'block') {
        throw new Error(item.value.reason ?? 'pre-compact hook blocked compaction.')
      }
      return
    }
    await args.options?.onHookEvent?.(item.value)
  }
}

async function runPreCompactHooks(args: {
  cwd: string
  compact: AgentCoreWillCompactContext
  options?: AgentCoreCompactHookOptions
}): Promise<void> {
  await runCompactHooks({
    phase: 'pre-compact',
    cwd: args.cwd,
    compact: args.compact,
    options: args.options
  })
}

async function runPostCompactHooks(args: {
  cwd: string
  record: AgentCoreCompactRecord
  estimatedInputTokens: number
  options?: AgentCoreCompactHookOptions
}): Promise<void> {
  await runCompactHooks({
    phase: 'post-compact',
    cwd: args.cwd,
    compact: {
      originalMessageCount: args.record.boundary.originalMessageCount,
      summarizedMessageCount: args.record.boundary.summarizedMessageCount,
      retainedMessageCount: args.record.boundary.retainedMessageCount,
      estimatedInputTokens: args.estimatedInputTokens,
      compactId: args.record.boundary.id,
      compactedAt: args.record.boundary.createdAt,
      summary: args.record.summary,
      record: args.record
    },
    options: args.options
  })
}

// 构造默认摘要器。压缩也是模型能力的一部分，不能只用字符串截断冒充上下文理解。
function createModelSummarizer(model: AgentCoreModelAdapter): AgentCoreSummarizer {
  return {
    async summarize(messages) {
      const response = await model.complete?.({
        systemPrompt: [
          'You are mllo Agent Core compacting an old conversation transcript.',
          'Write a concise but complete Chinese Markdown summary.',
          'Use sections: 目标, 已完成, 文件变更, 工具结果, 决策, 待办, 风险.',
          'Preserve exact file paths, commands, tool call ids, permission decisions, blockers, and pending tasks.',
          'Keep failed tool attempts only when they explain a later decision or unresolved risk.',
          'Keep enough context for a resumed agent to continue without rereading the whole transcript.',
          'Do not invent facts.'
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: renderAgentCoreCompactTranscript(messages)
          }
        ],
        tools: []
      })
      if (response === undefined) {
        throw new Error('Agent Core model does not support non-stream summary compaction.')
      }
      return response.content
    }
  }
}

// 读取当前 session 的文件变更历史。compact 摘要需要 diff 事实，不能只看 tool result 短句。
async function readSessionFileChanges(session: AgentCoreRunSession) {
  const changes = await readAgentCoreFileHistory({
    configDir: session.configDir,
    cwd: session.handle.cwd,
    sessionId: session.handle.sessionId
  })
  return changes
}

// 包装摘要器，把 file-change diff 作为额外上下文输入，而不是污染真实对话消息。
async function createFileChangeAwareSummarizer(args: {
  summarizer: AgentCoreSummarizer
  session: AgentCoreRunSession
  policy?: Partial<AgentCoreFileChangeCompactContextPolicy>
}): Promise<AgentCoreSummarizer> {
  const changes = await readSessionFileChanges(args.session)
  return {
    summarize(messages) {
      return args.summarizer.summarize(
        appendAgentCoreFileChangeCompactContext({
          messages,
          changes,
          policy: args.policy
        })
      )
    }
  }
}

// 写 compact record。resume 会从最新 compact record 之后恢复 message，避免旧上下文回流。
async function recordCompactResult(args: {
  session: AgentCoreRunSession
  record: AgentCoreCompactRecord
}): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createCompactRecordEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      record: args.record
    })
  )
}

// 对本轮 query messages 应用预算。没有触发 compact 时只返回原消息和估算状态。
export async function applyAgentCoreRunBudget(args: {
  messages: readonly AgentCoreMessage[]
  model: AgentCoreModelAdapter
  session: AgentCoreRunSession
  budget?: AgentCoreRunBudgetOptions
  hookOptions?: AgentCoreCompactHookOptions
}): Promise<AgentCoreRunBudgetResult> {
  const summarizer = await createFileChangeAwareSummarizer({
    summarizer: args.budget?.summarizer ?? createModelSummarizer(args.model),
    session: args.session,
    policy: args.budget?.fileChangeContext
  })
  const result = await applyAgentCoreBudget({
    messages: args.messages,
    policy: args.budget?.policy,
    summarizer,
    onWillCompact: async (compact) => {
      await runPreCompactHooks({
        cwd: args.session.handle.cwd,
        compact,
        options: args.hookOptions
      })
    }
  })

  if (result.compacted) {
    await recordCompactResult({
      session: args.session,
      record: result.record
    })
    if (args.budget?.writeSessionMemory !== false) {
      await recordAgentCoreSessionMemoryCompact({
        session: args.session,
        record: result.record,
        extractor: args.budget?.memoryExtractor ?? createModelMemoryExtractor(args.model),
        merger: args.budget?.memoryMerger ?? createModelMemoryMerger(args.model),
        mergeTriggerChars: args.budget?.memoryMergeTriggerChars,
        runtimeHome: {
          homePath: args.session.configDir
        }
      })
    }
    await runPostCompactHooks({
      cwd: args.session.handle.cwd,
      record: result.record,
      estimatedInputTokens: result.budgetState.estimatedInputTokens,
      options: args.hookOptions
    })
  }

  return {
    messages: result.messages,
    budgetState: result.budgetState,
    compacted: result.compacted
  }
}
