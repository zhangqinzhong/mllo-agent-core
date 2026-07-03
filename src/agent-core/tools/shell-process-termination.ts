import type { ChildProcess } from 'node:child_process'

export type AgentCoreShellTerminationResult =
  | 'process-group'
  | 'child-process'
  | 'missing-pid'
  | 'already-exited'

// 终止 shell 进程。POSIX 优先杀进程组，避免 shell 退出后留下 sleep/npm/test 子进程。
export function terminateAgentCoreShellProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM'
): AgentCoreShellTerminationResult {
  if (child.killed || child.exitCode !== null || child.signalCode !== null) {
    return 'already-exited'
  }
  if (child.pid === undefined) {
    return child.kill(signal) ? 'child-process' : 'missing-pid'
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return 'process-group'
    } catch {
      // 中文注释：有些平台/测试环境不允许 kill 进程组，退回单进程终止保持可用。
    }
  }
  return child.kill(signal) ? 'child-process' : 'already-exited'
}
