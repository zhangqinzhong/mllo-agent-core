import { randomUUID } from 'node:crypto'
import {
  appendAgentCoreWorkflowJournalEntry,
  type AgentCoreWorkflowRunJournalRecord,
  type AgentCoreWorkflowTaskJournalRecord,
  type AgentCoreWorkflowTaskJournalStatus
} from './agent-core-workflow-journal'
import type {
  AgentCoreWorkflowInput,
  AgentCoreWorkflowTaskStatus
} from './agent-core-workflow-runner'

// 初始化 run 快照，后续每个 task 状态都会在这份记录上推进。
export function createWorkflowRunRecord(
  input: AgentCoreWorkflowInput
): AgentCoreWorkflowRunJournalRecord {
  const timestamp = new Date().toISOString()
  return {
    runId: randomUUID(),
    goal: input.goal,
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    tasks: input.tasks.map((task) => {
      const record: AgentCoreWorkflowTaskJournalRecord = {
        id: task.id,
        agentId: task.agentId,
        prompt: task.prompt,
        status: 'pending',
        updatedAt: timestamp
      }
      if (task.dependsOn !== undefined) {
        record.dependsOn = task.dependsOn
      }
      return record
    })
  }
}

// 没有 journalPath 时保持工具可用，避免测试或嵌入场景被持久化强绑定。
export async function persistWorkflowRun(args: {
  journalPath: string | undefined
  run: AgentCoreWorkflowRunJournalRecord
}): Promise<void> {
  if (args.journalPath === undefined) {
    return
  }
  await appendAgentCoreWorkflowJournalEntry({
    journalPath: args.journalPath,
    run: args.run
  })
}

// 原地更新 task 快照，保证一次 append 写出的 run 是完整状态。
export function updateWorkflowTaskRecord(args: {
  run: AgentCoreWorkflowRunJournalRecord
  taskId: string
  status: AgentCoreWorkflowTaskJournalStatus
  content?: string
}): void {
  const timestamp = new Date().toISOString()
  const task = args.run.tasks.find((candidate) => candidate.id === args.taskId)
  if (task === undefined) {
    return
  }
  const nextTask: AgentCoreWorkflowTaskJournalRecord = {
    ...task,
    status: args.status,
    updatedAt: timestamp
  }
  if (args.content !== undefined) {
    nextTask.content = args.content
  }
  Object.assign(task, nextTask)
  args.run.updatedAt = timestamp
}

// 收尾时写 completedAt 和最终状态，GUI 可直接读最新快照恢复 workflow。
export async function finishWorkflowRun(args: {
  results: ReadonlyMap<string, AgentCoreWorkflowTaskStatus>
  run: AgentCoreWorkflowRunJournalRecord
  journalPath?: string
}): Promise<void> {
  const timestamp = new Date().toISOString()
  args.run.status = [...args.results.values()].every((result) => result.status === 'completed')
    ? 'completed'
    : 'failed'
  args.run.completedAt = timestamp
  args.run.updatedAt = timestamp
  await persistWorkflowRun({
    journalPath: args.journalPath,
    run: args.run
  })
}
