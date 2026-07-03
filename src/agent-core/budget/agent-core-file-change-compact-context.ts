import type { AgentCoreMessage } from '../query-loop/agent-core-query-types'
import type { AgentCoreFileHistoryEntry } from '../session/agent-core-file-history'

export type AgentCoreFileChangeCompactContextPolicy = {
  maxFileChanges: number
  maxDiffPreviewChars: number
}

export const DEFAULT_AGENT_CORE_FILE_CHANGE_COMPACT_CONTEXT_POLICY: AgentCoreFileChangeCompactContextPolicy =
  {
    maxFileChanges: 20,
    maxDiffPreviewChars: 6_000
  }

// 限制单个 diff preview。compact 摘要需要真实变更语义，但不能被超大 diff 淹没。
function limitDiffPreview(diffPreview: string, maxChars: number): string {
  if (diffPreview.length <= maxChars) {
    return diffPreview
  }
  return `${diffPreview.slice(0, maxChars)}\n[mllo diff preview truncated after ${maxChars} chars]`
}

// 选择最近的文件变更。旧变更多半已进入 summary，最近变更对下一步最关键。
function selectRecentFileChanges(
  changes: readonly AgentCoreFileHistoryEntry[],
  policy: AgentCoreFileChangeCompactContextPolicy
): AgentCoreFileHistoryEntry[] {
  return changes.slice(-policy.maxFileChanges)
}

// 渲染单个文件变更。这里保留路径、行数统计和 diff，便于 compact 后仍能审计改动。
function renderFileChange(
  change: AgentCoreFileHistoryEntry,
  index: number,
  policy: AgentCoreFileChangeCompactContextPolicy
): string {
  return [
    `## File Change ${index + 1}`,
    `timestamp: ${change.timestamp}`,
    `path: ${change.path}`,
    `replacementCount: ${change.replacementCount}`,
    `beforeLines: ${change.beforeLines}`,
    `afterLines: ${change.afterLines}`,
    `addedLines: ${change.addedLines}`,
    `removedLines: ${change.removedLines}`,
    `diffPreviewTruncated: ${change.diffPreviewTruncated ? 'yes' : 'no'}`,
    'diffPreview:',
    limitDiffPreview(change.diffPreview, policy.maxDiffPreviewChars)
  ].join('\n')
}

// 渲染 compact 专用文件变更上下文。空历史返回 undefined，避免给摘要器制造噪音。
export function renderAgentCoreFileChangeCompactContext(args: {
  changes: readonly AgentCoreFileHistoryEntry[]
  policy?: Partial<AgentCoreFileChangeCompactContextPolicy>
}): string | undefined {
  const policy = {
    ...DEFAULT_AGENT_CORE_FILE_CHANGE_COMPACT_CONTEXT_POLICY,
    ...args.policy
  }
  const selected = selectRecentFileChanges(args.changes, policy)
  if (selected.length === 0) {
    return undefined
  }
  return [
    '<mllo_file_change_context>',
    `fileChangeCount: ${selected.length}`,
    ...selected.map((change, index) => renderFileChange(change, index, policy)),
    '</mllo_file_change_context>'
  ].join('\n')
}

// 把文件变更上下文追加成一条 user message。摘要器只读它，不会把它写回真实对话历史。
export function appendAgentCoreFileChangeCompactContext(args: {
  messages: readonly AgentCoreMessage[]
  changes: readonly AgentCoreFileHistoryEntry[]
  policy?: Partial<AgentCoreFileChangeCompactContextPolicy>
}): AgentCoreMessage[] {
  const context = renderAgentCoreFileChangeCompactContext({
    changes: args.changes,
    policy: args.policy
  })
  if (context === undefined) {
    return [...args.messages]
  }
  return [
    ...args.messages,
    {
      role: 'user',
      content: context
    }
  ]
}
