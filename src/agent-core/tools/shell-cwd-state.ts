import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

type AgentCoreShellCwdState = {
  cwd: string
  updatedAt: string
}

// 读取上次 shell cwd。文件缺失时回到 workspace cwd，避免恢复失败阻断 agent run。
export async function readAgentCoreShellCwdState(args: {
  statePath: string
  fallbackCwd: string
}): Promise<string> {
  const content = await readFile(args.statePath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  })
  if (content === undefined) {
    return resolve(args.fallbackCwd)
  }
  const parsed = JSON.parse(content) as Partial<AgentCoreShellCwdState>
  return typeof parsed.cwd === 'string' && parsed.cwd.length > 0
    ? resolve(parsed.cwd)
    : resolve(args.fallbackCwd)
}

// 写入当前 shell cwd。它是会话运行态，不改变 workspace/project 的身份。
export async function writeAgentCoreShellCwdState(args: {
  statePath: string
  cwd: string
}): Promise<void> {
  await mkdir(dirname(args.statePath), {
    recursive: true
  })
  const state: AgentCoreShellCwdState = {
    cwd: resolve(args.cwd),
    updatedAt: new Date().toISOString()
  }
  await writeFile(args.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
