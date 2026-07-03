import type { AgentCoreWorker } from '../workers/agent-core-worker-types'
import type { AgentCoreToolDefinition, AgentCoreToolRunContext } from './agent-core-tool-types'
import type { AgentCoreWorkflowRunJournalRecord } from './agent-core-workflow-journal'
import {
  createWorkflowRunRecord,
  finishWorkflowRun,
  persistWorkflowRun,
  updateWorkflowTaskRecord
} from './agent-core-workflow-run-records'
import {
  blockedAgentCoreWorkflowTasks,
  readyAgentCoreWorkflowTasks
} from './agent-core-workflow-validation'
import { runAgentCoreWorkflowTask } from './agent-core-workflow-task-runner'

export type AgentCoreWorkflowTask = {
  id: string
  agentId: string
  prompt: string
  dependsOn?: string[]
  recovery?: AgentCoreWorkflowTaskRecovery
}

export type AgentCoreWorkflowTaskRecovery = {
  agentId?: string
  prompt: string
}

export type AgentCoreWorkflowInput = {
  goal: string
  tasks: AgentCoreWorkflowTask[]
}

export type AgentCoreWorkflowTaskStatus =
  | {
      status: 'completed'
      content: string
    }
  | {
      status: 'failed'
      content: string
    }
  | {
      status: 'denied'
      content: string
    }
  | {
      status: 'skipped'
      content: string
    }

// 依赖失败时要落 skipped 状态，GUI 才能解释为什么后续任务没跑。
async function skipBlockedTasks(args: {
  input: AgentCoreWorkflowInput
  finishedIds: Set<string>
  results: Map<string, AgentCoreWorkflowTaskStatus>
  runRecord: AgentCoreWorkflowRunJournalRecord
  journalPath?: string
  onProgress?: Parameters<AgentCoreToolDefinition['run']>[1]['onProgress']
}): Promise<void> {
  for (const task of blockedAgentCoreWorkflowTasks({
    tasks: args.input.tasks,
    finishedIds: args.finishedIds
  })) {
    const content = 'Skipped because dependencies did not complete.'
    args.results.set(task.id, {
      status: 'skipped',
      content
    })
    updateWorkflowTaskRecord({
      run: args.runRecord,
      taskId: task.id,
      status: 'skipped',
      content
    })
    await persistWorkflowRun({
      journalPath: args.journalPath,
      run: args.runRecord
    })
    args.onProgress?.({
      kind: 'workflow-event',
      event: {
        taskId: task.id,
        agentId: task.agentId,
        status: 'skipped',
        text: content
      }
    })
    args.finishedIds.add(task.id)
  }
}

// 同一批 ready task 可以并发跑，但每个任务启动前都要先写 running 快照。
async function runReadyBatch(args: {
  batch: readonly AgentCoreWorkflowTask[]
  input: AgentCoreWorkflowInput
  workers: readonly AgentCoreWorker[]
  results: Map<string, AgentCoreWorkflowTaskStatus>
  runRecord: AgentCoreWorkflowRunJournalRecord
  journalPath?: string
  cwd: string
  signal?: AbortSignal
  onProgress?: Parameters<AgentCoreToolDefinition['run']>[1]['onProgress']
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}): Promise<
  {
    task: AgentCoreWorkflowTask
    result: AgentCoreWorkflowTaskStatus
  }[]
> {
  return await Promise.all(
    args.batch.map(async (task) => {
      updateWorkflowTaskRecord({
        run: args.runRecord,
        taskId: task.id,
        status: 'running'
      })
      await persistWorkflowRun({
        journalPath: args.journalPath,
        run: args.runRecord
      })
      return {
        task,
        result: await runAgentCoreWorkflowTask({
          goal: args.input.goal,
          task,
          workers: args.workers,
          results: args.results,
          cwd: args.cwd,
          signal: args.signal,
          onProgress: args.onProgress,
          requestWorkerPermission: args.requestWorkerPermission
        })
      }
    })
  )
}

// 批量结果统一提交，避免 completedIds 和 journal 状态分叉。
async function recordBatchResults(args: {
  batchResults: readonly {
    task: AgentCoreWorkflowTask
    result: AgentCoreWorkflowTaskStatus
  }[]
  results: Map<string, AgentCoreWorkflowTaskStatus>
  completedIds: Set<string>
  finishedIds: Set<string>
  runRecord: AgentCoreWorkflowRunJournalRecord
  journalPath?: string
  onProgress?: Parameters<AgentCoreToolDefinition['run']>[1]['onProgress']
}): Promise<void> {
  for (const item of args.batchResults) {
    args.results.set(item.task.id, item.result)
    args.finishedIds.add(item.task.id)
    updateWorkflowTaskRecord({
      run: args.runRecord,
      taskId: item.task.id,
      status: item.result.status,
      content: item.result.content
    })
    await persistWorkflowRun({
      journalPath: args.journalPath,
      run: args.runRecord
    })
    args.onProgress?.({
      kind: 'workflow-event',
      event: {
        taskId: item.task.id,
        agentId: item.task.agentId,
        status: item.result.status === 'completed' ? 'done' : 'failed',
        text: item.result.content
      }
    })
    if (item.result.status === 'completed') {
      args.completedIds.add(item.task.id)
    }
  }
}

// 执行 dependency-aware workflow，并把每个阶段快照写入本次 run 的 journal。
export async function runAgentCoreWorkflow(args: {
  input: AgentCoreWorkflowInput
  workers: readonly AgentCoreWorker[]
  cwd: string
  journalPath?: string
  signal?: AbortSignal
  onProgress?: Parameters<AgentCoreToolDefinition['run']>[1]['onProgress']
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}): Promise<Map<string, AgentCoreWorkflowTaskStatus>> {
  const runRecord = createWorkflowRunRecord(args.input)
  await persistWorkflowRun({
    journalPath: args.journalPath,
    run: runRecord
  })
  const results = new Map<string, AgentCoreWorkflowTaskStatus>()
  const completedIds = new Set<string>()
  const finishedIds = new Set<string>()

  while (finishedIds.size < args.input.tasks.length) {
    const batch = readyAgentCoreWorkflowTasks({
      tasks: args.input.tasks,
      completedIds,
      finishedIds
    })
    if (batch.length === 0) {
      await skipBlockedTasks({
        input: args.input,
        finishedIds,
        results,
        runRecord,
        journalPath: args.journalPath,
        onProgress: args.onProgress
      })
      break
    }
    const batchResults = await runReadyBatch({
      batch,
      input: args.input,
      workers: args.workers,
      results,
      runRecord,
      journalPath: args.journalPath,
      cwd: args.cwd,
      signal: args.signal,
      onProgress: args.onProgress,
      requestWorkerPermission: args.requestWorkerPermission
    })
    await recordBatchResults({
      batchResults,
      results,
      completedIds,
      finishedIds,
      runRecord,
      journalPath: args.journalPath,
      onProgress: args.onProgress
    })
  }

  await finishWorkflowRun({
    results,
    run: runRecord,
    journalPath: args.journalPath
  })
  return results
}
