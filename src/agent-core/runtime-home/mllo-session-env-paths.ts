import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MlloHookPhase } from '../../../shared/mllo-hook-protocol'

const SESSION_ENV_PHASE_PREFIX: Partial<Record<MlloHookPhase, string>> = {
  'session-start': 'sessionstart',
  'cwd-changed': 'cwdchanged',
  'file-changed': 'filechanged'
}

const SESSION_ENV_PHASE_PRIORITY: Record<string, number> = {
  sessionstart: 0,
  cwdchanged: 1,
  filechanged: 2
}

const SESSION_ENV_FILE_RE = /^(sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/

// 中文注释：识别 ENOENT，用于把“还没有 session env”当成空环境处理。
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

// 中文注释：判断当前 hook phase 是否允许写入后续 shell 可继承的会话环境。
export function supportsMlloHookSessionEnv(phase: MlloHookPhase): boolean {
  return SESSION_ENV_PHASE_PREFIX[phase] !== undefined
}

// 中文注释：session env 跟随 thread runtime，避免同项目多个会话共享 hook 产物。
export function getMlloSessionEnvDir(runtimeDir: string): string {
  return join(runtimeDir, 'session-env')
}

// 中文注释：为单个 hook 分配固定 env file，hook 可写入 POSIX export 脚本。
export async function getMlloHookSessionEnvFilePath(args: {
  runtimeDir: string
  phase: MlloHookPhase
  hookIndex: number
}): Promise<string | undefined> {
  const prefix = SESSION_ENV_PHASE_PREFIX[args.phase]
  if (prefix === undefined) {
    return undefined
  }
  const dir = getMlloSessionEnvDir(args.runtimeDir)
  await mkdir(dir, {
    recursive: true
  })
  return join(dir, `${prefix}-hook-${args.hookIndex}.sh`)
}

// 中文注释：按 phase 和 hook 顺序排序，保证每次 shell 注入环境的结果稳定。
function sortSessionEnvFiles(a: string, b: string): number {
  const aMatch = a.match(SESSION_ENV_FILE_RE)
  const bMatch = b.match(SESSION_ENV_FILE_RE)
  const aPhase = aMatch?.[1] ?? ''
  const bPhase = bMatch?.[1] ?? ''
  if (aPhase !== bPhase) {
    return (SESSION_ENV_PHASE_PRIORITY[aPhase] ?? 99) - (SESSION_ENV_PHASE_PRIORITY[bPhase] ?? 99)
  }
  return Number(aMatch?.[2] ?? 0) - Number(bMatch?.[2] ?? 0)
}

// 中文注释：读取当前 session 的环境脚本；空目录和空文件都不影响 shell 命令执行。
export async function readMlloSessionEnvScript(args: {
  runtimeDir: string
}): Promise<string | undefined> {
  const dir = getMlloSessionEnvDir(args.runtimeDir)
  const files = await readdir(dir).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return []
    }
    throw error
  })
  const scripts = await Promise.all(
    files
      .filter((file) => SESSION_ENV_FILE_RE.test(file))
      .sort(sortSessionEnvFiles)
      .map(async (file) => (await readFile(join(dir, file), 'utf8')).trim())
  )
  const content = scripts.filter((script) => script.length > 0).join('\n')
  return content.length === 0 ? undefined : content
}
