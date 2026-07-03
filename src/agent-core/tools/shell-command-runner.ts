import type { AgentCoreToolProgress } from './agent-core-tool-types'
import type { AgentCoreShellCwdTracker } from './shell-cwd-tracker'
import {
  terminateAgentCoreShellProcess,
  type AgentCoreShellTerminationResult
} from './shell-process-termination'
import { buildAgentCoreShellSpawnSpec } from './shell-spawn-provider'
import {
  appendAgentCoreShellOutputProgress,
  createAgentCoreShellOutputTarget
} from './shell-command-output-progress'
import {
  updateAgentCoreShellCwdFromFile,
  updateAgentCoreShellCwdFromTrackedValue
} from './shell-cwd-tracking-command'
import {
  buildAgentCoreShellEnvironment,
  type AgentCoreShellSessionEnvironment
} from './shell-environment-policy'
import {
  localAgentCoreShellExecutionBackend,
  type AgentCoreShellCwdTrackingMode,
  type AgentCoreShellExecutionBackend
} from './shell-execution-backend'
import { createAgentCoreShellTaskOutput } from './shell-task-output'
import {
  defaultAgentCoreShellTaskRegistry,
  type AgentCoreShellTaskRegistry
} from './shell-task-registry'
import {
  shellTaskBackendRecord,
  shellTaskSessionRecord,
  shellTaskStatus
} from './shell-command-task-records'
import {
  AGENT_CORE_SHELL_DEFAULT_TIMEOUT_MS,
  type AgentCoreShellCommandInput,
  type AgentCoreShellCommandOutput
} from './shell-command-types'
import { prepareAgentCoreShellRuntimeCommand } from './shell-command-runtime-command'

export type AgentCoreShellCommandRunnerOptions = {
  cwd: string
  outputDir?: string
  signal?: AbortSignal
  onProgress?: (progress: AgentCoreToolProgress) => void
  taskRegistry?: AgentCoreShellTaskRegistry
  cwdTracker?: AgentCoreShellCwdTracker
  executionBackend?: AgentCoreShellExecutionBackend
  sessionEnvironment?: AgentCoreShellSessionEnvironment
}

// 执行 shell 命令。它负责 stdout/stderr progress、timeout、abort 和后台返回。
export async function runAgentCoreShellCommand(
  input: AgentCoreShellCommandInput,
  options: AgentCoreShellCommandRunnerOptions
): Promise<AgentCoreShellCommandOutput> {
  const startedAt = Date.now()
  const { taskId, outputPath, cwdPath } = await createAgentCoreShellOutputTarget(options.outputDir)
  const output = await createAgentCoreShellTaskOutput(outputPath)
  const registry = options.taskRegistry ?? defaultAgentCoreShellTaskRegistry
  const cwd = options.cwdTracker?.getCwd() ?? options.cwd
  const backend = options.executionBackend ?? localAgentCoreShellExecutionBackend
  const cwdTrackingMode: AgentCoreShellCwdTrackingMode = backend.cwdTrackingMode ?? 'file'
  let timedOut = false
  let interrupted = false
  let terminationResult: AgentCoreShellTerminationResult | undefined
  const timeoutMs = input.timeoutMs ?? AGENT_CORE_SHELL_DEFAULT_TIMEOUT_MS
  const runtimeCommand = await prepareAgentCoreShellRuntimeCommand({
    command: input.command,
    cwdPath,
    cwdTrackingMode,
    runInBackground: input.runInBackground === true,
    sessionEnvironment: options.sessionEnvironment,
    taskId
  })
  const stdoutCwdParser = runtimeCommand.stdoutCwdParser
  const spawnSpec = await buildAgentCoreShellSpawnSpec(runtimeCommand.command)
  const environment = buildAgentCoreShellEnvironment({
    session: options.sessionEnvironment,
    overrides: input.env,
    remote: backend.remote === true,
    remoteEnvironmentPolicy: backend.remoteEnvironmentPolicy
  })
  const child = backend.spawn({
    file: spawnSpec.file,
    args: spawnSpec.args,
    cwd,
    detached: process.platform !== 'win32',
    env: environment.env,
    forwardedEnv: environment.forwardedEnv,
    shell: spawnSpec.shell
  })
  registry.register({
    taskId,
    command: input.command,
    cwd,
    outputPath,
    child,
    startedAt,
    executionBackend: shellTaskBackendRecord(backend),
    session: shellTaskSessionRecord(options.sessionEnvironment)
  })

  // 杀掉 shell 进程组。timeout 和用户 cancel 共用这条路径，但记录不同原因。
  function killChild(reason: 'timeout' | 'interrupt'): void {
    if (reason === 'timeout') {
      timedOut = true
    } else {
      interrupted = true
    }
    terminationResult = terminateAgentCoreShellProcess(child, 'SIGTERM')
  }

  const timeout = setTimeout(() => {
    killChild('timeout')
  }, timeoutMs)
  timeout.unref()

  const abortListener = (): void => {
    killChild('interrupt')
  }
  options.signal?.addEventListener('abort', abortListener, {
    once: true
  })

  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    const visibleText = stdoutCwdParser?.consume(text) ?? text
    appendAgentCoreShellOutputProgress({
      stream: 'stdout',
      chunk: visibleText,
      output,
      startedAt,
      taskId,
      onProgress: options.onProgress
    })
  })
  child.stderr.on('data', (chunk: Buffer) => {
    appendAgentCoreShellOutputProgress({
      stream: 'stderr',
      chunk: chunk.toString('utf8'),
      output,
      startedAt,
      taskId,
      onProgress: options.onProgress
    })
  })

  if (input.runInBackground === true) {
    options.onProgress?.({
      kind: 'shell-backgrounded',
      taskId,
      outputPath,
      elapsedMs: Date.now() - startedAt
    })
    let backgroundFinalized = false
    const finalizeBackground = (args: {
      exitCode: number | null
      signal: NodeJS.Signals | null
      errorMessage?: string
    }): void => {
      if (backgroundFinalized) {
        return
      }
      backgroundFinalized = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortListener)
      registry.complete(taskId, {
        exitCode: args.exitCode,
        signal: args.signal,
        elapsedMs: Date.now() - startedAt,
        status:
          args.errorMessage === undefined
            ? shellTaskStatus({
                timedOut,
                interrupted,
                exitCode: args.exitCode
              })
            : 'failed',
        terminationResult,
        errorMessage: args.errorMessage
      })
      void output.close()
    }
    void child.once('error', (error) => {
      finalizeBackground({
        exitCode: null,
        signal: null,
        errorMessage: error.message
      })
    })
    void child.once('close', (exitCode, signal) => {
      finalizeBackground({
        exitCode,
        signal
      })
    })
    return {
      command: input.command,
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null,
      elapsedMs: Date.now() - startedAt,
      timedOut: false,
      interrupted: false,
      terminationResult,
      envWarnings: environment.warnings,
      cwd,
      backgroundTaskId: taskId,
      outputPath
    }
  }

  return await new Promise<AgentCoreShellCommandOutput>((resolve) => {
    let finalized = false
    const finalizeForeground = (args: {
      exitCode: number | null
      signal: NodeJS.Signals | null
      errorMessage?: string
    }): void => {
      if (finalized) {
        return
      }
      finalized = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortListener)
      const status =
        args.errorMessage === undefined
          ? shellTaskStatus({
              timedOut,
              interrupted,
              exitCode: args.exitCode
            })
          : 'failed'
      registry.complete(taskId, {
        exitCode: args.exitCode,
        signal: args.signal,
        elapsedMs: Date.now() - startedAt,
        status,
        terminationResult,
        errorMessage: args.errorMessage
      })
      void (async () => {
        if (args.errorMessage === undefined) {
          const flushedStdout = stdoutCwdParser?.flush() ?? ''
          appendAgentCoreShellOutputProgress({
            stream: 'stdout',
            chunk: flushedStdout,
            output,
            startedAt,
            taskId,
            onProgress: options.onProgress
          })
        }
        const cwdChanged =
          args.errorMessage === undefined
            ? cwdTrackingMode === 'stdout-marker'
              ? updateAgentCoreShellCwdFromTrackedValue({
                  cwd: stdoutCwdParser?.getCwd(),
                  cwdTracker: options.cwdTracker
                })
              : await updateAgentCoreShellCwdFromFile({
                  cwdPath,
                  cwdTracker: options.cwdTracker
                })
            : undefined
        await output.close()
        const snapshot = output.snapshot()
        resolve({
          command: input.command,
          stdout: snapshot.stdout,
          stderr: snapshot.stderr,
          exitCode: args.exitCode,
          signal: args.signal,
          elapsedMs: Date.now() - startedAt,
          timedOut,
          interrupted,
          terminationResult,
          errorMessage: args.errorMessage,
          envWarnings: environment.warnings,
          cwd: cwdChanged?.currentCwd ?? cwd,
          cwdChanged,
          outputPath
        })
      })()
    }
    child.once('error', (error) => {
      finalizeForeground({
        exitCode: null,
        signal: null,
        errorMessage: error.message
      })
    })
    child.once('close', (exitCode, signal) => {
      finalizeForeground({
        exitCode,
        signal
      })
    })
  })
}
