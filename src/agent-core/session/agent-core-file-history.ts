import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  getMlloProjectDir,
  getMlloProjectFileHistoryPath,
  getMlloThreadFileHistoryPath
} from '../runtime-home/mllo-home-paths'
import type { AgentCoreFileChangeProgress } from '../tools/agent-core-tool-types'

export type AgentCoreFileHistoryEntry = {
  kind: 'file-change'
  uuid: string
  timestamp: string
  sessionId: string
  cwd: string
  path: string
  replacementCount: number
  beforeLines: number
  afterLines: number
  addedLines: number
  removedLines: number
  diffPreview: string
  diffPreviewTruncated: boolean
}

export type AgentCoreFileHistoryAppendArgs = {
  configDir: string
  sessionId: string
  cwd: string
  change: AgentCoreFileChangeProgress
}

function nowIso(): string {
  return new Date().toISOString()
}

function serializeFileHistoryEntry(entry: AgentCoreFileHistoryEntry): string {
  return `${JSON.stringify(entry)}\n`
}

function isFileHistoryEntry(value: unknown): value is AgentCoreFileHistoryEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'file-change' &&
    'uuid' in value &&
    typeof value.uuid === 'string' &&
    'timestamp' in value &&
    typeof value.timestamp === 'string' &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'cwd' in value &&
    typeof value.cwd === 'string' &&
    'path' in value &&
    typeof value.path === 'string' &&
    'replacementCount' in value &&
    typeof value.replacementCount === 'number' &&
    'beforeLines' in value &&
    typeof value.beforeLines === 'number' &&
    'afterLines' in value &&
    typeof value.afterLines === 'number' &&
    'addedLines' in value &&
    typeof value.addedLines === 'number' &&
    'removedLines' in value &&
    typeof value.removedLines === 'number' &&
    'diffPreview' in value &&
    typeof value.diffPreview === 'string' &&
    'diffPreviewTruncated' in value &&
    typeof value.diffPreviewTruncated === 'boolean'
  )
}

function parseFileHistoryLine(line: string, lineNumber: number): AgentCoreFileHistoryEntry {
  try {
    const value = JSON.parse(line) as unknown
    if (!isFileHistoryEntry(value)) {
      throw new Error('entry is not a file-change history record')
    }
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid Agent Core file history JSONL at line ${lineNumber}: ${message}`)
  }
}

function projectFileHistoryPath(args: { configDir: string; cwd: string }): string {
  return getMlloProjectFileHistoryPath(args.cwd, {
    homePath: args.configDir
  })
}

function threadFileHistoryPath(args: {
  configDir: string
  cwd: string
  sessionId: string
}): string {
  return getMlloThreadFileHistoryPath({
    homePath: args.configDir,
    projectPath: args.cwd,
    threadId: args.sessionId
  })
}

async function readFileHistoryPath(path: string): Promise<AgentCoreFileHistoryEntry[]> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => parseFileHistoryLine(line, index + 1))
}

async function threadFileHistoryPaths(args: { configDir: string; cwd: string }): Promise<string[]> {
  const threadsDir = join(
    getMlloProjectDir(args.cwd, {
      homePath: args.configDir
    }),
    'threads'
  )
  try {
    const entries = await readdir(threadsDir, {
      withFileTypes: true
    })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        threadFileHistoryPath({
          configDir: args.configDir,
          cwd: args.cwd,
          sessionId: entry.name
        })
      )
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

// 追加文件变更审计记录。完整事实流仍在 rollout，file-history 用于快速查写文件轨迹。
export async function appendAgentCoreFileHistoryEntry(
  args: AgentCoreFileHistoryAppendArgs
): Promise<AgentCoreFileHistoryEntry> {
  const entry: AgentCoreFileHistoryEntry = {
    kind: 'file-change',
    uuid: randomUUID(),
    timestamp: nowIso(),
    sessionId: args.sessionId,
    cwd: args.cwd,
    path: args.change.path,
    replacementCount: args.change.replacementCount,
    beforeLines: args.change.beforeLines,
    afterLines: args.change.afterLines,
    addedLines: args.change.addedLines,
    removedLines: args.change.removedLines,
    diffPreview: args.change.diffPreview,
    diffPreviewTruncated: args.change.diffPreviewTruncated
  }
  const historyPath = threadFileHistoryPath({
    configDir: args.configDir,
    cwd: args.cwd,
    sessionId: args.sessionId
  })
  await mkdir(dirname(historyPath), {
    recursive: true
  })
  await appendFile(historyPath, serializeFileHistoryEntry(entry), 'utf8')
  return entry
}

// 读取项目文件变更历史。坏行报错，避免 GUI 用损坏审计记录误导用户。
export async function readAgentCoreFileHistory(args: {
  configDir: string
  cwd: string
  sessionId?: string
}): Promise<AgentCoreFileHistoryEntry[]> {
  if (args.sessionId !== undefined) {
    return await readFileHistoryPath(
      threadFileHistoryPath({
        configDir: args.configDir,
        cwd: args.cwd,
        sessionId: args.sessionId
      })
    )
  }
  const paths = [projectFileHistoryPath(args), ...(await threadFileHistoryPaths(args))]
  const entries = await Promise.all(paths.map(readFileHistoryPath))
  return entries.flat()
}
