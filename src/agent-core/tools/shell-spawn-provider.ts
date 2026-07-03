import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'

export type AgentCoreShellSpawnSpec = {
  file: string
  args: string[]
  shell: boolean
}

const POSIX_SHELL_CANDIDATES = [
  '/bin/zsh',
  '/usr/bin/zsh',
  '/usr/local/bin/zsh',
  '/opt/homebrew/bin/zsh',
  '/bin/bash',
  '/usr/bin/bash',
  '/usr/local/bin/bash',
  '/opt/homebrew/bin/bash',
  '/bin/sh',
  '/usr/bin/sh'
]

// 判断一个路径是否是可执行 shell。检测失败时只返回 false，不让 shell 选择中断命令执行。
async function isExecutableShell(shellPath: string): Promise<boolean> {
  return await access(shellPath, fsConstants.X_OK)
    .then(() => true)
    .catch(() => false)
}

// 只接受 sh/bash/zsh。fish/csh 语义不同，会破坏 cwd tracking 的 POSIX 包装。
function isSupportedPosixShell(shellPath: string | undefined): shellPath is string {
  return (
    shellPath !== undefined &&
    (shellPath.endsWith('/zsh') || shellPath.endsWith('/bash') || shellPath.endsWith('/sh'))
  )
}

// 找到当前平台最合适的 POSIX shell。优先用户 SHELL，再回退常见安装路径。
export async function findAgentCorePosixShell(): Promise<string | undefined> {
  const candidates = [
    ...(isSupportedPosixShell(process.env.SHELL) ? [process.env.SHELL] : []),
    ...POSIX_SHELL_CANDIDATES
  ]
  for (const shellPath of candidates) {
    if (await isExecutableShell(shellPath)) {
      return shellPath
    }
  }
  return undefined
}

// 构造 spawn 参数。Windows 先走 Node 默认 shell，POSIX 则显式使用 zsh/bash/sh。
export async function buildAgentCoreShellSpawnSpec(
  command: string
): Promise<AgentCoreShellSpawnSpec> {
  if (process.platform === 'win32') {
    return {
      file: command,
      args: [],
      shell: true
    }
  }
  const shellPath = (await findAgentCorePosixShell()) ?? '/bin/sh'
  return {
    file: shellPath,
    args: ['-lc', command],
    shell: false
  }
}
