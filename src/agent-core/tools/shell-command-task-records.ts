import type { AgentCoreShellSessionEnvironment } from './shell-environment-policy'
import type { AgentCoreShellExecutionBackend } from './shell-execution-backend'
import type {
  AgentCoreShellTaskBackendRecord,
  AgentCoreShellTaskSessionRecord,
  AgentCoreShellTaskStatus
} from './shell-task-registry'

// 按结束原因决定 registry 状态。timeout/cancel 要覆盖 exit code 的普通失败判断。
export function shellTaskStatus(args: {
  timedOut: boolean
  interrupted: boolean
  exitCode: number | null
}): AgentCoreShellTaskStatus {
  if (args.timedOut) {
    return 'timed-out'
  }
  if (args.interrupted) {
    return 'cancelled'
  }
  return args.exitCode === 0 ? 'completed' : 'failed'
}

export function shellTaskBackendRecord(
  backend: AgentCoreShellExecutionBackend
): AgentCoreShellTaskBackendRecord {
  return {
    kind: backend.kind,
    remote: backend.remote === true,
    sandboxed: backend.sandboxed === true,
    ...(backend.label === undefined ? {} : { label: backend.label }),
    ...(backend.cwdTrackingMode === undefined ? {} : { cwdTrackingMode: backend.cwdTrackingMode })
  }
}

export function shellTaskSessionRecord(
  session: AgentCoreShellSessionEnvironment | undefined
): AgentCoreShellTaskSessionRecord | undefined {
  return session === undefined
    ? undefined
    : {
        projectDir: session.projectDir,
        runtimeDir: session.runtimeDir,
        ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId })
      }
}
