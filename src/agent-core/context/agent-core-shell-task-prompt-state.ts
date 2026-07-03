import type { AgentCoreShellTaskRecord } from '../tools/shell-task-registry'

const MAX_AGENT_CORE_PROMPT_SHELL_TASKS = 8

export type AgentCoreShellTaskPromptRecord = {
  taskId: string
  command: string
  cwd: string
  outputPath: string
  backendKind?: string
  backendRemote?: boolean
  backendSandboxed?: boolean
  sessionId?: string
  status: string
  startedAt: number
  updatedAt: number
  completedAt?: number
}

// prompt 只暴露任务索引和输出路径，详细日志由 shell_tasks 工具按需读取。
export function createAgentCoreShellTaskPromptState(
  tasks: readonly AgentCoreShellTaskRecord[]
): AgentCoreShellTaskPromptRecord[] {
  return [...tasks]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_AGENT_CORE_PROMPT_SHELL_TASKS)
    .map((task) => {
      const record: AgentCoreShellTaskPromptRecord = {
        taskId: task.taskId,
        command: task.command,
        cwd: task.cwd,
        outputPath: task.outputPath,
        status: task.status,
        startedAt: task.startedAt,
        updatedAt: task.updatedAt
      }
      if (task.completedAt !== undefined) {
        record.completedAt = task.completedAt
      }
      if (task.executionBackend !== undefined) {
        record.backendKind = task.executionBackend.kind
        record.backendRemote = task.executionBackend.remote
        record.backendSandboxed = task.executionBackend.sandboxed
      }
      if (task.session?.sessionId !== undefined) {
        record.sessionId = task.session.sessionId
      }
      return record
    })
}
