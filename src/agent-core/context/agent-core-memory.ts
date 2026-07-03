import { readFile } from 'node:fs/promises'
import {
  getMlloGlobalMemoryPath,
  getMlloMemorySummaryPath,
  getMlloProjectMemoryPath
} from '../runtime-home/mllo-home-paths'
import type { MlloRuntimeHomeOptions } from '../runtime-home/mllo-runtime-home-types'

export type AgentCoreMemoryEntry = {
  scope: 'global-summary' | 'global' | 'project'
  path: string
  content: string
}

export type AgentCoreMemoryReadOptions = MlloRuntimeHomeOptions & {
  cwd: string
}

async function readOptionalMemoryFile(args: {
  scope: AgentCoreMemoryEntry['scope']
  path: string
}): Promise<AgentCoreMemoryEntry | undefined> {
  // memory 文件是可选运行态文件；缺失时跳过，其他 IO 错误继续暴露给调用方。
  try {
    const content = await readFile(args.path, 'utf8')
    return content.trim().length === 0
      ? undefined
      : {
          scope: args.scope,
          path: args.path,
          content
        }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

// 读取 mllo 长期记忆。这里只读不写，避免 context builder 意外修改用户记忆。
export async function readAgentCoreMemory(
  options: AgentCoreMemoryReadOptions
): Promise<AgentCoreMemoryEntry[]> {
  const entries = await Promise.all([
    readOptionalMemoryFile({
      scope: 'global-summary',
      path: getMlloMemorySummaryPath(options)
    }),
    readOptionalMemoryFile({
      scope: 'global',
      path: getMlloGlobalMemoryPath(options)
    }),
    readOptionalMemoryFile({
      scope: 'project',
      path: getMlloProjectMemoryPath(options.cwd, options)
    })
  ])
  return entries.filter((entry): entry is AgentCoreMemoryEntry => entry !== undefined)
}
