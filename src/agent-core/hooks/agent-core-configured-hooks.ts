import { spawn } from 'node:child_process'
import { computeMlloCommandHookTrustedHash } from './agent-core-command-hook-trust'
import { buildAgentCoreShellSpawnSpec } from '../tools/shell-spawn-provider'
import { terminateAgentCoreShellProcess } from '../tools/shell-process-termination'
import type { AgentCoreHookContext, AgentCoreHookDefinition } from './agent-core-hook-types'
import type { MlloAgentCoreConfig } from '../model/agent-core-mllo-config'
import { matchesMlloHookMatcher } from '../../../shared/mllo-hook-matcher'
import { getMlloHookSessionEnvFilePath } from '../runtime-home/mllo-session-env-paths'

const DEFAULT_HOOK_TIMEOUT_MS = 30_000

type MlloCommandHookConfig = NonNullable<MlloAgentCoreConfig['hooks']>[number]

export type MlloConfiguredHooksRuntime = {
  runtimeDir?: string
  sessionId?: string
}

export { computeMlloCommandHookTrustedHash }

// 校验 hook command 是否仍是用户信任过的版本。缺失 hash 时默认不执行。
function trustedHookError(hook: MlloCommandHookConfig): string | null {
  const expectedHash = computeMlloCommandHookTrustedHash(hook.command)
  if (hook.trustedHash === undefined) {
    return `Hook command is not trusted: ${hook.name}. Expected trustedHash ${expectedHash}.`
  }
  if (hook.trustedHash !== expectedHash) {
    return `Hook command trust hash mismatch: ${hook.name}. Expected ${expectedHash}, got ${hook.trustedHash}.`
  }
  return null
}

// 从普通 tool input 里提取常见路径字段。不同文件工具字段名不同，matcher 需要统一入口。
function extractInputPaths(input: unknown): string[] {
  if (input === null || typeof input !== 'object') {
    return []
  }
  const record = input as Record<string, unknown>
  const directPaths = ['path', 'filePath', 'targetPath'].flatMap((key) =>
    typeof record[key] === 'string' ? [record[key] as string] : []
  )
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((path): path is string => typeof path === 'string')
    : []
  return [...directPaths, ...paths]
}

// 判断 command hook matcher 是否命中当前上下文。所有已配置条件都必须满足。
function matchesMlloCommandHookMatcher(
  matcher: MlloCommandHookConfig['matcher'],
  context: AgentCoreHookContext
): boolean {
  const filePathCandidates = [
    ...(context.fileChange === undefined ? [] : [context.fileChange.path]),
    ...extractInputPaths(context.call?.input)
  ]
  return matchesMlloHookMatcher(matcher, {
    toolName: context.call?.name,
    filePaths: filePathCandidates,
    cwd: context.cwd,
    userPrompt: context.userPrompt,
    workerId: context.subagentEvent?.workerId
  })
}

// 去掉不能 JSON 化的 signal。hook command 通过 stdin 拿结构化上下文。
function serializeHookContext(context: AgentCoreHookContext): string {
  const { signal: _signal, ...serializable } = context
  return `${JSON.stringify(serializable)}\n`
}

// 把 hook 命令的退出结果转成 hook 决策。非零退出表示阻止当前阶段。
function commandHookDecision(args: {
  exitCode: number | null
  stdout: string
  stderr: string
}): { action: 'continue'; content?: string } | { action: 'block'; reason: string } {
  const output = [args.stdout.trim(), args.stderr.trim()].filter(Boolean).join('\n')
  if (args.exitCode === 0) {
    return {
      action: 'continue',
      content: output.length === 0 ? undefined : output
    }
  }
  return {
    action: 'block',
    reason: output.length === 0 ? `Hook command exited with code ${args.exitCode}.` : output
  }
}

// 中文注释：给 command hook 注入 mllo 运行态信息，env file 只给 POSIX shell 脚本使用。
async function buildCommandHookEnv(args: {
  hook: MlloCommandHookConfig
  hookIndex: number
  context: AgentCoreHookContext
  runtime?: MlloConfiguredHooksRuntime
}): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MLLO_AGENT_CORE: '1',
    MLLO_PROJECT_DIR: args.context.cwd
  }
  if (args.runtime?.runtimeDir !== undefined) {
    env.MLLO_AGENT_CORE_RUNTIME_DIR = args.runtime.runtimeDir
  }
  if (args.runtime?.sessionId !== undefined) {
    env.MLLO_AGENT_CORE_SESSION_ID = args.runtime.sessionId
  }
  if (process.platform !== 'win32' && args.runtime?.runtimeDir !== undefined) {
    const envFilePath = await getMlloHookSessionEnvFilePath({
      runtimeDir: args.runtime.runtimeDir,
      phase: args.hook.phase,
      hookIndex: args.hookIndex
    })
    if (envFilePath !== undefined) {
      env.MLLO_ENV_FILE = envFilePath
    }
  }
  return env
}

// 执行一个 command hook。timeout 和 abort 都会终止进程组，避免 hook 卡死主 agent。
async function runCommandHook(
  hook: MlloCommandHookConfig,
  context: AgentCoreHookContext,
  runtime: MlloConfiguredHooksRuntime | undefined,
  hookIndex: number
): Promise<Awaited<ReturnType<AgentCoreHookDefinition['run']>>> {
  const spawnSpec = await buildAgentCoreShellSpawnSpec(hook.command)
  const env = await buildCommandHookEnv({
    hook,
    hookIndex,
    context,
    runtime
  })
  return await new Promise((resolve) => {
    const child = spawn(spawnSpec.file, spawnSpec.args, {
      cwd: context.cwd,
      detached: process.platform !== 'win32',
      env,
      shell: spawnSpec.shell,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let interrupted = false
    const timeout = setTimeout(() => {
      timedOut = true
      terminateAgentCoreShellProcess(child, 'SIGTERM')
    }, hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)
    timeout.unref()
    const abortListener = (): void => {
      interrupted = true
      terminateAgentCoreShellProcess(child, 'SIGTERM')
    }
    context.signal?.addEventListener('abort', abortListener, {
      once: true
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('close', (exitCode) => {
      clearTimeout(timeout)
      context.signal?.removeEventListener('abort', abortListener)
      if (timedOut) {
        resolve({
          action: 'block',
          reason: `Hook command timed out after ${hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS}ms.`
        })
        return
      }
      if (interrupted) {
        resolve({
          action: 'block',
          reason: 'Hook command interrupted.'
        })
        return
      }
      resolve(
        commandHookDecision({
          exitCode,
          stdout,
          stderr
        })
      )
    })
    child.stdin.end(serializeHookContext(context))
  })
}

// 把 mllo 配置里的 command hooks 转成 queryLoop 可执行的 hook definitions。
export function createMlloConfiguredHooks(
  config: MlloAgentCoreConfig | undefined,
  runtime?: MlloConfiguredHooksRuntime
): AgentCoreHookDefinition[] {
  return (config?.hooks ?? []).map((hook, hookIndex) => ({
    name: hook.name,
    phase: hook.phase,
    shouldRun(context) {
      return matchesMlloCommandHookMatcher(hook.matcher, context)
    },
    async run(context) {
      const trustError = trustedHookError(hook)
      if (trustError !== null) {
        return {
          action: 'block',
          reason: trustError
        }
      }
      return runCommandHook(hook, context, runtime, hookIndex)
    }
  }))
}
