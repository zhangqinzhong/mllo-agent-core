import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getMlloHistoryPath } from '../runtime-home/mllo-home-paths'

export type AgentCoreInputHistoryEntry = {
  kind: 'input'
  uuid: string
  timestamp: string
  sessionId: string
  cwd: string
  input: string
}

export type AgentCoreInputHistoryAppendArgs = {
  configDir: string
  sessionId: string
  cwd: string
  input: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function serializeHistoryEntry(entry: AgentCoreInputHistoryEntry): string {
  return `${JSON.stringify(entry)}\n`
}

function isInputHistoryEntry(value: unknown): value is AgentCoreInputHistoryEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'input' &&
    'uuid' in value &&
    typeof value.uuid === 'string' &&
    'timestamp' in value &&
    typeof value.timestamp === 'string' &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'cwd' in value &&
    typeof value.cwd === 'string' &&
    'input' in value &&
    typeof value.input === 'string'
  )
}

function parseHistoryLine(line: string, lineNumber: number): AgentCoreInputHistoryEntry {
  try {
    const value = JSON.parse(line) as unknown
    if (!isInputHistoryEntry(value)) {
      throw new Error('entry is not an input history record')
    }
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid Agent Core input history JSONL at line ${lineNumber}: ${message}`)
  }
}

// 追加用户输入历史，供 GUI/CLI 恢复输入记录；完整会话事实仍以 rollout JSONL 为准。
export async function appendAgentCoreInputHistoryEntry(
  args: AgentCoreInputHistoryAppendArgs
): Promise<AgentCoreInputHistoryEntry> {
  const entry: AgentCoreInputHistoryEntry = {
    kind: 'input',
    uuid: randomUUID(),
    timestamp: nowIso(),
    sessionId: args.sessionId,
    cwd: args.cwd,
    input: args.input
  }
  const historyPath = getMlloHistoryPath({
    homePath: args.configDir
  })
  await mkdir(dirname(historyPath), {
    recursive: true
  })
  await appendFile(historyPath, serializeHistoryEntry(entry), 'utf8')
  return entry
}

// 读取输入历史。坏行直接报错，避免 UI 基于损坏 history 展示误导性记录。
export async function readAgentCoreInputHistory(
  configDir: string
): Promise<AgentCoreInputHistoryEntry[]> {
  const historyPath = getMlloHistoryPath({
    homePath: configDir
  })
  let content: string
  try {
    content = await readFile(historyPath, 'utf8')
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
    .map((line, index) => parseHistoryLine(line, index + 1))
}
