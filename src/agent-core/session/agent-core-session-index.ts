import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getMlloSessionIndexPath } from '../runtime-home/mllo-home-paths'

export type AgentCoreSessionIndexEntry = {
  kind: 'session-created'
  uuid: string
  timestamp: string
  sessionId: string
  cwd: string
  workspaceRoots: string[]
  projectDir: string
  transcriptPath: string
  createdAt: string
}

export type AgentCoreSessionIndexCreateArgs = {
  configDir: string
  sessionId: string
  cwd: string
  workspaceRoots: string[]
  projectDir: string
  transcriptPath: string
  createdAt: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function serializeIndexEntry(entry: AgentCoreSessionIndexEntry): string {
  return `${JSON.stringify(entry)}\n`
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isSessionIndexEntry(value: unknown): value is AgentCoreSessionIndexEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'session-created' &&
    'uuid' in value &&
    typeof value.uuid === 'string' &&
    'timestamp' in value &&
    typeof value.timestamp === 'string' &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'cwd' in value &&
    typeof value.cwd === 'string' &&
    'workspaceRoots' in value &&
    isStringArray(value.workspaceRoots) &&
    'projectDir' in value &&
    typeof value.projectDir === 'string' &&
    'transcriptPath' in value &&
    typeof value.transcriptPath === 'string' &&
    'createdAt' in value &&
    typeof value.createdAt === 'string'
  )
}

function parseIndexLine(line: string, lineNumber: number): AgentCoreSessionIndexEntry {
  try {
    const value = JSON.parse(line) as unknown
    if (!isSessionIndexEntry(value)) {
      throw new Error('entry is not a session-created record')
    }
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid Agent Core session index JSONL at line ${lineNumber}: ${message}`)
  }
}

// 创建 session-created 索引记录，索引只做发现用途，完整事实仍在 rollout JSONL。
export function createAgentCoreSessionIndexEntry(
  args: Omit<AgentCoreSessionIndexCreateArgs, 'configDir'>
): AgentCoreSessionIndexEntry {
  return {
    kind: 'session-created',
    uuid: randomUUID(),
    timestamp: nowIso(),
    sessionId: args.sessionId,
    cwd: args.cwd,
    workspaceRoots: args.workspaceRoots,
    projectDir: args.projectDir,
    transcriptPath: args.transcriptPath,
    createdAt: args.createdAt
  }
}

// 追加 session 索引，让 GUI 能从固定文件发现可恢复会话而不是扫描所有项目目录。
export async function appendAgentCoreSessionIndexEntry(
  args: AgentCoreSessionIndexCreateArgs
): Promise<AgentCoreSessionIndexEntry> {
  const entry = createAgentCoreSessionIndexEntry(args)
  const indexPath = getMlloSessionIndexPath({
    homePath: args.configDir
  })
  await mkdir(dirname(indexPath), {
    recursive: true
  })
  await appendFile(indexPath, serializeIndexEntry(entry), 'utf8')
  return entry
}

// 读取 session index。坏行直接报错，避免 GUI 基于损坏索引展示错误会话。
export async function readAgentCoreSessionIndex(
  configDir: string
): Promise<AgentCoreSessionIndexEntry[]> {
  const indexPath = getMlloSessionIndexPath({
    homePath: configDir
  })
  let content: string
  try {
    content = await readFile(indexPath, 'utf8')
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
    .map((line, index) => parseIndexLine(line, index + 1))
}
