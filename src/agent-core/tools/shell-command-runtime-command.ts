import { readMlloSessionEnvScript } from '../runtime-home/mllo-session-env-paths'
import {
  createAgentCoreStdoutCwdMarkerParser,
  wrapAgentCoreShellCommandForCwdFileTracking,
  wrapAgentCoreShellCommandForStdoutCwdTracking
} from './shell-cwd-tracking-command'
import type { AgentCoreShellSessionEnvironment } from './shell-environment-policy'
import type { AgentCoreShellCwdTrackingMode } from './shell-execution-backend'

export type AgentCorePreparedShellCommand = {
  command: string
  stdoutCwdParser?: ReturnType<typeof createAgentCoreStdoutCwdMarkerParser>
}

// 中文注释：加载 hook 写入的 session env；只注入 POSIX shell，和 .sh 文件语义保持一致。
async function prependSessionEnvScript(args: {
  command: string
  sessionEnvironment?: AgentCoreShellSessionEnvironment
}): Promise<string> {
  if (process.platform === 'win32' || args.sessionEnvironment === undefined) {
    return args.command
  }
  const sessionEnvScript = await readMlloSessionEnvScript({
    runtimeDir: args.sessionEnvironment.runtimeDir
  })
  return sessionEnvScript === undefined ? args.command : `${sessionEnvScript}\n${args.command}`
}

export async function prepareAgentCoreShellRuntimeCommand(args: {
  command: string
  cwdPath: string
  cwdTrackingMode: AgentCoreShellCwdTrackingMode
  runInBackground: boolean
  sessionEnvironment?: AgentCoreShellSessionEnvironment
  taskId: string
}): Promise<AgentCorePreparedShellCommand> {
  const startMarker = `__MLLO_CWD_START_${args.taskId}__`
  const endMarker = `__MLLO_CWD_END_${args.taskId}__`
  const stdoutCwdParser =
    args.runInBackground || args.cwdTrackingMode === 'file'
      ? undefined
      : createAgentCoreStdoutCwdMarkerParser({
          startMarker,
          endMarker
        })
  const wrappedCommand = args.runInBackground
    ? args.command
    : args.cwdTrackingMode === 'stdout-marker'
      ? wrapAgentCoreShellCommandForStdoutCwdTracking({
          command: args.command,
          startMarker,
          endMarker
        })
      : wrapAgentCoreShellCommandForCwdFileTracking(args.command, args.cwdPath)
  return {
    command: await prependSessionEnvScript({
      command: wrappedCommand,
      sessionEnvironment: args.sessionEnvironment
    }),
    stdoutCwdParser
  }
}
