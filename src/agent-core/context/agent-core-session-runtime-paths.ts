import {
  getMlloProjectCheckpointsDir,
  getMlloProjectDir,
  getMlloProjectPlanPath,
  getMlloProjectShellCwdPath,
  getMlloProjectShellOutputDir,
  getMlloProjectShellTasksPath,
  getMlloProjectWorkflowRunsPath,
  getMlloThreadCheckpointsDir,
  getMlloThreadPlanPath,
  getMlloThreadRuntimeDir,
  getMlloThreadShellCwdPath,
  getMlloThreadShellOutputDir,
  getMlloThreadShellTasksPath,
  getMlloThreadWorkflowRunsPath
} from '../runtime-home/mllo-home-paths'
import type { MlloRuntimeHomeOptions } from '../runtime-home/mllo-runtime-home-types'
import type { AgentCoreSessionHandle } from '../session/agent-core-session-types'

export type AgentCoreSessionRuntimePaths = {
  runtimeDir: string
  checkpointDir: string
  shellTaskJournalPath: string
  shellOutputDir: string
  shellCwdPath: string
  planJournalPath: string
  workflowJournalPath: string
}

// 计算本次 run 的运行态路径。正常 session 使用 thread 级目录，无 session 时才回退 project 级兼容。
export function createAgentCoreSessionRuntimePaths(args: {
  cwd: string
  sessionHandle?: AgentCoreSessionHandle
  runtimeHome?: MlloRuntimeHomeOptions
}): AgentCoreSessionRuntimePaths {
  const threadId = args.sessionHandle?.sessionId
  if (threadId !== undefined) {
    const threadArgs = {
      ...args.runtimeHome,
      projectPath: args.cwd,
      threadId
    }
    return {
      runtimeDir: getMlloThreadRuntimeDir(threadArgs),
      checkpointDir: getMlloThreadCheckpointsDir(threadArgs),
      shellTaskJournalPath: getMlloThreadShellTasksPath(threadArgs),
      shellOutputDir: getMlloThreadShellOutputDir(threadArgs),
      shellCwdPath: getMlloThreadShellCwdPath(threadArgs),
      planJournalPath: getMlloThreadPlanPath(threadArgs),
      workflowJournalPath: getMlloThreadWorkflowRunsPath(threadArgs)
    }
  }
  return {
    runtimeDir: getMlloProjectDir(args.cwd, args.runtimeHome),
    checkpointDir: getMlloProjectCheckpointsDir(args.cwd, args.runtimeHome),
    shellTaskJournalPath: getMlloProjectShellTasksPath(args.cwd, args.runtimeHome),
    shellOutputDir: getMlloProjectShellOutputDir(args.cwd, args.runtimeHome),
    shellCwdPath: getMlloProjectShellCwdPath(args.cwd, args.runtimeHome),
    planJournalPath: getMlloProjectPlanPath(args.cwd, args.runtimeHome),
    workflowJournalPath: getMlloProjectWorkflowRunsPath(args.cwd, args.runtimeHome)
  }
}
