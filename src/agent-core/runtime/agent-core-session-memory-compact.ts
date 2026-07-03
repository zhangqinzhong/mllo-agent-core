import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentCoreCompactRecord } from '../budget/agent-core-budget-types'
import type { AgentCoreModelAdapter } from '../query-loop/agent-core-query-types'
import { getMlloProjectMemoryPath } from '../runtime-home/mllo-home-paths'
import type { MlloRuntimeHomeOptions } from '../runtime-home/mllo-runtime-home-types'
import type { AgentCoreJsonlSessionStore } from '../session/agent-core-jsonl-session-store'
import type { AgentCoreSessionHandle } from '../session/agent-core-session-types'
import { dedupeAgentCoreSessionMemory } from './agent-core-session-memory-dedupe'

type AgentCoreSessionMemorySession = {
  store: AgentCoreJsonlSessionStore
  handle: AgentCoreSessionHandle
}

const DEFAULT_MEMORY_MERGE_TRIGGER_CHARS = 24_000
const STRUCTURED_MEMORY_SECTIONS = ['偏好', '项目事实', '架构决策', '待办', '风险'] as const

export type AgentCoreMemoryExtractionInput = {
  sessionId: string
  cwd: string
  record: AgentCoreCompactRecord
}

export type AgentCoreMemoryExtractor = {
  extract: (input: AgentCoreMemoryExtractionInput) => Promise<string>
}

export type AgentCoreMemoryMergeInput = {
  sessionId: string
  cwd: string
  memoryPath: string
  existingMemory: string
  newMemory: string
  record: AgentCoreCompactRecord
}

export type AgentCoreMemoryMerger = {
  merge: (input: AgentCoreMemoryMergeInput) => Promise<string>
}

// 渲染结构化 memory 章节说明。默认 merger 必须输出固定章节，避免长期记忆越来越散。
function renderStructuredMemorySectionInstruction(): string {
  return [
    'Output exactly these top-level Markdown sections in this order:',
    ...STRUCTURED_MEMORY_SECTIONS.map((section) => `## ${section}`),
    'Each section must contain concise Chinese bullets.',
    'Use "- none" when a section has no durable facts.'
  ].join('\n')
}

// 把模型输出规范化成固定章节。模型偶尔漏章节时，这里补齐，保证 MEMORY.md 形状稳定。
export function normalizeStructuredAgentCoreMemory(memory: string): string {
  const source = memory.trim()
  const sections = new Map<string, string>()
  for (const [index, section] of STRUCTURED_MEMORY_SECTIONS.entries()) {
    const current = `## ${section}`
    const nextSection = STRUCTURED_MEMORY_SECTIONS[index + 1]
    const next = nextSection === undefined ? undefined : `## ${nextSection}`
    const start = source.indexOf(current)
    if (start === -1) {
      sections.set(section, '- none')
      continue
    }
    const bodyStart = start + current.length
    const bodyEnd = next === undefined ? source.length : source.indexOf(next, bodyStart)
    const body = source.slice(bodyStart, bodyEnd === -1 ? source.length : bodyEnd).trim()
    sections.set(section, body.length === 0 ? '- none' : body)
  }
  return STRUCTURED_MEMORY_SECTIONS.map((section) => `## ${section}\n\n${sections.get(section)}`)
    .join('\n\n')
    .trim()
}

// 构造默认 memory extractor。长期记忆要提炼稳定事实，不能把临时日志整段写入 MEMORY.md。
export function createModelMemoryExtractor(model: AgentCoreModelAdapter): AgentCoreMemoryExtractor {
  return {
    async extract(input) {
      const response = await model.complete?.({
        systemPrompt: [
          'You are mllo Agent Core extracting durable project memory from a compact summary.',
          'Write Chinese Markdown bullets only.',
          'Keep stable user preferences, project facts, architecture decisions, blockers, and durable TODOs.',
          'Drop transient logs, repeated command output, temporary errors, and facts that only mattered during the old turn.',
          'Return an empty string if there is no durable memory.'
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: [
              `sessionId: ${input.sessionId}`,
              `cwd: ${input.cwd}`,
              `compactId: ${input.record.boundary.id}`,
              '',
              input.record.summary
            ].join('\n')
          }
        ],
        tools: []
      })
      if (response === undefined) {
        throw new Error('Agent Core model does not support session memory extraction.')
      }
      return response.content.trim()
    }
  }
}

// 构造默认 memory merger。已有 memory 过长时，用模型合并成稳定项目记忆，而不是无限追加。
export function createModelMemoryMerger(model: AgentCoreModelAdapter): AgentCoreMemoryMerger {
  return {
    async merge(input) {
      const response = await model.complete?.({
        systemPrompt: [
          'You are mllo Agent Core merging project memory.',
          'Write concise Chinese Markdown.',
          renderStructuredMemorySectionInstruction(),
          'Preserve durable user preferences, project facts, architecture decisions, blockers, and TODOs.',
          'Remove duplicate or obsolete phrasing.',
          'Do not invent facts.',
          'Keep useful source hints such as sessionId or compactId only when they help trace important decisions.'
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: [
              `sessionId: ${input.sessionId}`,
              `cwd: ${input.cwd}`,
              `memoryPath: ${input.memoryPath}`,
              `compactId: ${input.record.boundary.id}`,
              '',
              '# Existing Memory',
              input.existingMemory,
              '',
              '# New Memory',
              input.newMemory
            ].join('\n')
          }
        ],
        tools: []
      })
      if (response === undefined) {
        throw new Error('Agent Core model does not support session memory merge.')
      }
      return normalizeStructuredAgentCoreMemory(response.content)
    }
  }
}

// 渲染 compact summary 到项目 MEMORY.md。这里保留 compact 元数据，方便后续人工追溯来源。
function renderProjectMemoryAppend(args: {
  sessionId: string
  cwd: string
  record: AgentCoreCompactRecord
  memory: string
}): string {
  return [
    '',
    `## Session Compact Memory ${args.record.boundary.createdAt}`,
    '',
    `- sessionId: ${args.sessionId}`,
    `- cwd: ${args.cwd}`,
    `- compactId: ${args.record.boundary.id}`,
    `- summarizedMessageCount: ${args.record.boundary.summarizedMessageCount}`,
    '',
    args.memory.trim(),
    ''
  ].join('\n')
}

// 判断是否需要模型级 merge。小 memory 用 append 更可审计，大 memory 再压缩。
function shouldMergeProjectMemory(args: {
  existingMemory: string
  newMemory: string
  triggerChars: number
}): boolean {
  return args.existingMemory.length + args.newMemory.length >= args.triggerChars
}

// 读取已有项目 memory。文件缺失是正常情况；其他 IO 错误继续抛出。
async function readExistingProjectMemory(memoryPath: string): Promise<string> {
  try {
    return await readFile(memoryPath, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}

// 把 compact summary 写入项目长期记忆。下一轮 context builder 会通过 readAgentCoreMemory 读回。
export async function recordAgentCoreSessionMemoryCompact(args: {
  session: AgentCoreSessionMemorySession
  record: AgentCoreCompactRecord
  extractor: AgentCoreMemoryExtractor
  merger?: AgentCoreMemoryMerger
  mergeTriggerChars?: number
  runtimeHome?: MlloRuntimeHomeOptions
}): Promise<void> {
  const memoryPath = getMlloProjectMemoryPath(args.session.handle.cwd, args.runtimeHome)
  const memory = await args.extractor.extract({
    sessionId: args.session.handle.sessionId,
    cwd: args.session.handle.cwd,
    record: args.record
  })
  if (memory.trim().length === 0) {
    return
  }
  const existingMemory = await readExistingProjectMemory(memoryPath)
  const deduped = dedupeAgentCoreSessionMemory({
    existingMemory,
    extractedMemory: memory
  })
  if (deduped.memory.length === 0) {
    return
  }
  const content = renderProjectMemoryAppend({
    sessionId: args.session.handle.sessionId,
    cwd: args.session.handle.cwd,
    record: args.record,
    memory: deduped.memory
  })
  await mkdir(dirname(memoryPath), {
    recursive: true
  })
  if (
    args.merger !== undefined &&
    shouldMergeProjectMemory({
      existingMemory,
      newMemory: content,
      triggerChars: args.mergeTriggerChars ?? DEFAULT_MEMORY_MERGE_TRIGGER_CHARS
    })
  ) {
    const merged = await args.merger.merge({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      memoryPath,
      existingMemory,
      newMemory: content,
      record: args.record
    })
    if (merged.length === 0) {
      return
    }
    await writeFile(memoryPath, `${merged.trim()}\n`, 'utf8')
  } else {
    await appendFile(memoryPath, content, 'utf8')
  }
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createMemoryEventEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      scope: 'project',
      path: memoryPath,
      compactId: args.record.boundary.id,
      summary: deduped.memory
    })
  )
}
