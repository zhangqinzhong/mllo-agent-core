import type { AgentCoreQueryEvent } from '../query-loop/agent-core-query-types'
import type { AgentCoreToolProgress } from '../tools/agent-core-tool-types'
import type { MlloStateStore } from '../runtime-state/mllo-state-store'
import type { MlloTaskStatus } from '../runtime-state/mllo-task-records'
import type { AgentCoreWorker, AgentCoreWorkerEvent } from '../workers/agent-core-worker-types'

type SyncRunProgressStateArgs = {
  stateStore: MlloStateStore
  threadId: string
  cwd: string
  event: AgentCoreQueryEvent
  workers: readonly AgentCoreWorker[]
}

function nowMs(): number {
  return Date.now()
}

function buildTaskId(threadId: string, taskId: string): string {
  return `${threadId}:${taskId}`
}

function workflowStatusToTaskStatus(status: string): MlloTaskStatus {
  switch (status) {
    case 'running':
      return 'running'
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'blocked'
    default:
      return 'pending'
  }
}

function findWorker(
  workers: readonly AgentCoreWorker[],
  workerId: string
): AgentCoreWorker | undefined {
  return workers.find((worker) => worker.id === workerId)
}

// 将 workflow task 进度写入 tasks 表，让 GUI 能直接展示真实任务状态。
function syncWorkflowProgress(args: {
  stateStore: MlloStateStore
  threadId: string
  progress: Extract<AgentCoreToolProgress, { kind: 'workflow-event' }>
}): void {
  const event = args.progress.event
  const existing = args.stateStore.getTask(buildTaskId(args.threadId, event.taskId))
  const timestamp = nowMs()
  args.stateStore.upsertTask({
    id: buildTaskId(args.threadId, event.taskId),
    threadId: args.threadId,
    subject: event.taskId,
    description: event.text ?? existing?.description ?? '',
    status: workflowStatusToTaskStatus(event.status),
    assignee: event.agentId,
    blockedBy: existing?.blockedBy ?? [],
    blocks: existing?.blocks ?? [],
    createdAtMs: existing?.createdAtMs ?? timestamp,
    updatedAtMs: timestamp
  })
}

function workerNameFromEvent(event: AgentCoreWorkerEvent): string {
  return event.type === 'worker-start' ? event.label : event.workerId
}

// 将 worker 事件写入 team_members 表，后续 Participants 面板不再依赖 mock。
function syncWorkerProgress(args: {
  stateStore: MlloStateStore
  threadId: string
  cwd: string
  workers: readonly AgentCoreWorker[]
  progress: Extract<AgentCoreToolProgress, { kind: 'worker-event' }>
}): void {
  const event = args.progress.event
  const worker = findWorker(args.workers, event.workerId)
  const existing = args.stateStore.getTeamMember(args.threadId, event.workerId)
  const timestamp = nowMs()
  args.stateStore.upsertTeamMember({
    teamId: args.threadId,
    agentId: event.workerId,
    agentType: 'external-worker',
    backendType: worker?.id ?? event.workerId,
    name: worker?.label ?? existing?.name ?? workerNameFromEvent(event),
    cwd: args.cwd,
    subscriptions: [...(worker?.capabilities ?? existing?.subscriptions ?? [])],
    runtimeHandle: existing?.runtimeHandle,
    joinedAtMs: existing?.joinedAtMs ?? timestamp,
    updatedAtMs: timestamp
  })
}

// 把 query-loop 的进度事件同步进 state.sqlite，保持 GUI 状态和 JSONL timeline 同源。
export function syncAgentCoreRunProgressState(args: SyncRunProgressStateArgs): void {
  if (args.event.type !== 'tool-progress') {
    return
  }
  if (args.event.progress.kind === 'workflow-event') {
    syncWorkflowProgress({
      stateStore: args.stateStore,
      threadId: args.threadId,
      progress: args.event.progress
    })
    return
  }
  if (args.event.progress.kind === 'worker-event') {
    syncWorkerProgress({
      stateStore: args.stateStore,
      threadId: args.threadId,
      cwd: args.cwd,
      workers: args.workers,
      progress: args.event.progress
    })
  }
}
