import type { AgentCoreWorkflowRunJournalRecord } from '../tools/agent-core-workflow-journal'

const MAX_AGENT_CORE_PROMPT_WORKFLOW_RUNS = 5

export type AgentCoreWorkflowPromptTask = {
  id: string
  agentId: string
  status: string
  updatedAt: string
}

export type AgentCoreWorkflowPromptRun = {
  runId: string
  goal: string
  status: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  tasks: AgentCoreWorkflowPromptTask[]
}

// prompt 只需要最近 workflow 的状态索引，完整历史继续留在 JSONL journal。
export function createAgentCoreWorkflowPromptState(
  runs: readonly AgentCoreWorkflowRunJournalRecord[]
): AgentCoreWorkflowPromptRun[] {
  return [...runs]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_AGENT_CORE_PROMPT_WORKFLOW_RUNS)
    .map((run) => {
      const promptRun: AgentCoreWorkflowPromptRun = {
        runId: run.runId,
        goal: run.goal,
        status: run.status,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        tasks: run.tasks.map((task) => ({
          id: task.id,
          agentId: task.agentId,
          status: task.status,
          updatedAt: task.updatedAt
        }))
      }
      if (run.completedAt !== undefined) {
        promptRun.completedAt = run.completedAt
      }
      return promptRun
    })
}
