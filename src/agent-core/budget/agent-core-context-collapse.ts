import type { AgentCoreMessage } from '../query-loop/agent-core-query-types'
import type { AgentCoreMemoryEntry } from '../context/agent-core-memory'
import type { AgentCoreCompactBoundary } from './agent-core-budget-types'

export type AgentCoreContextCollapseInput = {
  boundary: AgentCoreCompactBoundary
  summary: string
  memory?: readonly AgentCoreMemoryEntry[]
  retainedMessages: readonly AgentCoreMessage[]
}

// 渲染 compact 边界。模型需要知道摘要覆盖范围，才能判断哪些历史不能再逐字追溯。
function renderBoundary(boundary: AgentCoreCompactBoundary): string {
  return [
    `compactId: ${boundary.id}`,
    `createdAt: ${boundary.createdAt}`,
    `originalMessageCount: ${boundary.originalMessageCount}`,
    `retainedMessageCount: ${boundary.retainedMessageCount}`,
    `summarizedMessageCount: ${boundary.summarizedMessageCount}`
  ].join('\n')
}

// 渲染长期记忆。context collapse 可以直接带记忆快照，避免恢复时只剩短摘要。
function renderMemory(memory: readonly AgentCoreMemoryEntry[]): string {
  if (memory.length === 0) {
    return '- none'
  }
  return memory
    .map((entry) => [`scope: ${entry.scope}`, `source: ${entry.path}`, entry.content].join('\n'))
    .join('\n\n---\n\n')
}

// 渲染 tail 状态而不重复 tail 内容。真正的 tail message 会原样追加，避免上下文重复膨胀。
function renderRetainedTail(retainedMessages: readonly AgentCoreMessage[]): string {
  return [
    `messageCount: ${retainedMessages.length}`,
    'note: The retained recent messages are appended after this collapse message in original form.'
  ].join('\n')
}

// 构造坍缩后的上下文消息。它把旧历史摘要、长期记忆和最近 tail 的边界放在同一个协议块里。
export function createAgentCoreContextCollapseMessage(
  input: AgentCoreContextCollapseInput
): AgentCoreMessage {
  return {
    role: 'user',
    content: [
      '<mllo_context_collapse>',
      '# Compact Boundary',
      renderBoundary(input.boundary),
      '',
      '# Durable Memory',
      renderMemory(input.memory ?? []),
      '',
      '# Compact Summary',
      input.summary,
      '',
      '# Retained Recent Tail',
      renderRetainedTail(input.retainedMessages),
      '</mllo_context_collapse>'
    ].join('\n')
  }
}

// 生成模型实际接收的投影上下文。collapse message 在前，最近 tail 保持原始顺序。
export function collapseAgentCoreMessages(
  input: AgentCoreContextCollapseInput
): AgentCoreMessage[] {
  return [createAgentCoreContextCollapseMessage(input), ...input.retainedMessages]
}
