import type { AgentCorePlanSnapshot } from '../tools/agent-core-plan-journal'

export type AgentCorePlanPromptItem = {
  step: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentCorePlanPromptState = {
  explanation?: string
  updatedAt: string
  items: AgentCorePlanPromptItem[]
}

// prompt 使用只读快照，避免渲染层直接持有 journal 内部对象。
export function createAgentCorePlanPromptState(
  snapshot: AgentCorePlanSnapshot | undefined
): AgentCorePlanPromptState | undefined {
  if (snapshot === undefined) {
    return undefined
  }
  const promptState: AgentCorePlanPromptState = {
    updatedAt: snapshot.updatedAt,
    items: snapshot.items.map((item) => {
      const promptItem: AgentCorePlanPromptItem = {
        step: item.step,
        status: item.status
      }
      if (item.activeForm !== undefined) {
        promptItem.activeForm = item.activeForm
      }
      return promptItem
    })
  }
  if (snapshot.explanation !== undefined) {
    promptState.explanation = snapshot.explanation
  }
  return promptState
}
