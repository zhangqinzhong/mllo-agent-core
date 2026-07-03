import { readFile } from 'node:fs/promises'
import type { AgentCoreToolResult } from './agent-core-tool-types'

export type AgentCoreStaleFileWriteArgs = {
  path: string
  resolvedPath: string
  expectedContent: string | null
  toolName: string
}

async function readLatestUtf8File(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  }
}

// 写盘前重新读取文件，避免 edit_file/multi_edit 覆盖并发 agent 或用户刚写入的内容。
export async function detectAgentCoreStaleFileWrite(
  args: AgentCoreStaleFileWriteArgs
): Promise<AgentCoreToolResult | null> {
  const latestContent = await readLatestUtf8File(args.resolvedPath)
  if (latestContent === args.expectedContent) {
    return null
  }
  return {
    content: `${args.toolName} aborted because ${args.path} changed before write. Read the latest file content and retry the edit.`,
    isError: true
  }
}
