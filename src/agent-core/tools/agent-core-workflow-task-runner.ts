import type { AgentCoreWorker } from '../workers/agent-core-worker-types'
import type { AgentCoreToolProgress, AgentCoreToolRunContext } from './agent-core-tool-types'
import { checkAgentCoreWorkerAvailability } from './agent-core-worker-tool-availability'
import type {
  AgentCoreWorkflowTask,
  AgentCoreWorkflowTaskStatus
} from './agent-core-workflow-runner'

type WorkflowWorkerStepArgs = {
  goal: string
  task: AgentCoreWorkflowTask
  workers: readonly AgentCoreWorker[]
  results: ReadonlyMap<string, AgentCoreWorkflowTaskStatus>
  cwd: string
  signal?: AbortSignal
  onProgress?: (progress: AgentCoreToolProgress) => void
  requestWorkerPermission?: AgentCoreToolRunContext['requestWorkerPermission']
}

// 根据任务声明找到可执行 worker，未注册的 worker 会在任务结果里显式失败。
function findWorker(
  workers: readonly AgentCoreWorker[],
  agentId: string
): AgentCoreWorker | undefined {
  return workers.find((worker) => worker.id === agentId)
}

// 给子 agent 注入上游结果，让 workflow 任务不是孤立 prompt。
function createTaskPrompt(args: {
  goal: string
  task: AgentCoreWorkflowTask
  results: ReadonlyMap<string, AgentCoreWorkflowTaskStatus>
}): string {
  const dependencyContext = (args.task.dependsOn ?? [])
    .map((dependency) => {
      const result = args.results.get(dependency)
      return result === undefined
        ? `Dependency ${dependency}: unavailable`
        : `Dependency ${dependency}: ${result.status}\n${result.content}`
    })
    .join('\n\n')
  return [
    `Workflow goal: ${args.goal}`,
    `Task id: ${args.task.id}`,
    '',
    'Task prompt:',
    args.task.prompt,
    '',
    'Dependency context:',
    dependencyContext.length === 0 ? 'none' : dependencyContext
  ].join('\n')
}

function emitWorkerPermissionDecision(args: {
  worker: AgentCoreWorker
  requestId: string
  decision: Awaited<ReturnType<NonNullable<AgentCoreToolRunContext['requestWorkerPermission']>>>
  onProgress?: (progress: AgentCoreToolProgress) => void
}): void {
  args.onProgress?.({
    kind: 'worker-event',
    event: {
      type: 'permission-decision',
      workerId: args.worker.id,
      requestId: args.requestId,
      status: args.decision.status,
      reason:
        args.decision.status === 'allow'
          ? 'Allowed by mllo worker permission bridge.'
          : args.decision.reason
    }
  })
}

async function runWorkflowWorkerStep(
  args: WorkflowWorkerStepArgs
): Promise<AgentCoreWorkflowTaskStatus> {
  const worker = findWorker(args.workers, args.task.agentId)
  args.onProgress?.({
    kind: 'workflow-event',
    event: {
      taskId: args.task.id,
      agentId: args.task.agentId,
      status: 'running',
      text: args.task.prompt
    }
  })
  if (worker === undefined) {
    return {
      status: 'failed',
      content: `Worker is not registered: ${args.task.agentId}`
    }
  }
  const availability = await checkAgentCoreWorkerAvailability(worker)
  if (!availability.available) {
    return {
      status: 'failed',
      content: `Worker is unavailable: ${worker.id}. ${availability.reason ?? 'No reason provided.'}`
    }
  }
  try {
    const result = await worker.run({
      prompt: createTaskPrompt({
        goal: args.goal,
        task: args.task,
        results: args.results
      }),
      cwd: args.cwd,
      signal: args.signal,
      onEvent(event) {
        args.onProgress?.({
          kind: 'worker-event',
          event
        })
      },
      async requestPermission(request) {
        args.onProgress?.({
          kind: 'worker-event',
          event: {
            type: 'permission-request',
            workerId: worker.id,
            ...request
          }
        })
        const decision = (await args.requestWorkerPermission?.({
          workerId: worker.id,
          ...request
        })) ?? {
          status: 'deny',
          reason: 'No worker permission bridge is available.'
        }
        emitWorkerPermissionDecision({
          worker,
          requestId: request.requestId,
          decision,
          onProgress: args.onProgress
        })
        return decision
      }
    })
    return {
      status: result.status === 'denied' ? 'denied' : 'completed',
      content: result.content
    }
  } catch (error) {
    return {
      status: 'failed',
      content: error instanceof Error ? error.message : String(error)
    }
  }
}

function statusLabel(status: AgentCoreWorkflowTaskStatus['status']): string {
  return status
}

function createRecoveryWorkflowTask(args: {
  task: AgentCoreWorkflowTask
  primaryResult: AgentCoreWorkflowTaskStatus
}): AgentCoreWorkflowTask {
  const recovery = args.task.recovery
  if (recovery === undefined) {
    return args.task
  }
  const recoveryTask: AgentCoreWorkflowTask = {
    id: args.task.id,
    agentId: recovery.agentId ?? args.task.agentId,
    // recovery 复用原 task id，避免 GUI/journal 出现声明外的动态 DAG 节点。
    prompt: [
      `Recover workflow task ${args.task.id}.`,
      '',
      'Original task prompt:',
      args.task.prompt,
      '',
      'Original task status:',
      args.primaryResult.status,
      '',
      'Original task result:',
      args.primaryResult.content,
      '',
      'Recovery instruction:',
      recovery.prompt
    ].join('\n')
  }
  if (args.task.dependsOn !== undefined) {
    recoveryTask.dependsOn = args.task.dependsOn
  }
  return recoveryTask
}

function combineRecoveryResult(args: {
  primaryResult: AgentCoreWorkflowTaskStatus
  recoveryResult: AgentCoreWorkflowTaskStatus
}): AgentCoreWorkflowTaskStatus {
  const content = [
    `Primary task ${statusLabel(args.primaryResult.status)}:`,
    args.primaryResult.content,
    '',
    `Recovery task ${args.recoveryResult.status}:`,
    args.recoveryResult.content
  ].join('\n')
  return {
    status: args.recoveryResult.status,
    content
  }
}

// 执行单个 workflow task，并在失败时按任务声明做一次补救恢复。
export async function runAgentCoreWorkflowTask(
  args: WorkflowWorkerStepArgs
): Promise<AgentCoreWorkflowTaskStatus> {
  const primaryResult = await runWorkflowWorkerStep(args)
  if (primaryResult.status === 'completed' || args.task.recovery === undefined) {
    return primaryResult
  }
  const recoveryTask = createRecoveryWorkflowTask({
    task: args.task,
    primaryResult
  })
  const recoveryResult = await runWorkflowWorkerStep({
    ...args,
    task: recoveryTask
  })
  return combineRecoveryResult({
    primaryResult,
    recoveryResult
  })
}
