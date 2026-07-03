import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { AgentCoreSessionEntry, AgentCoreSessionMetadata } from './agent-core-session-types'

// 生成 ISO 时间字符串。集中封装方便测试或后续注入 clock。
export function createAgentCoreSessionTimestamp(): string {
  return new Date().toISOString()
}

// 序列化 JSONL 单行。append-only 文件必须保证每个 entry 独占一行。
export function serializeAgentCoreSessionEntry(entry: AgentCoreSessionEntry): string {
  return `${JSON.stringify(entry)}\n`
}

// 解析 JSONL 内容。空行跳过，坏行保留错误上下文并抛出。
export function parseAgentCoreSessionJsonl(content: string): AgentCoreSessionEntry[] {
  const entries: AgentCoreSessionEntry[] = []
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line.length === 0) {
      continue
    }
    try {
      entries.push(JSON.parse(line) as AgentCoreSessionEntry)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid Agent Core session JSONL at line ${index + 1}: ${message}`)
    }
  }
  return entries
}

// 创建标准 entry 外壳。每条记录都带 sessionId/cwd，方便跨项目全局扫描。
export function withAgentCoreSessionEntryEnvelope<
  T extends Omit<AgentCoreSessionEntry, 'uuid' | 'timestamp'>
>(entry: T): T & Pick<AgentCoreSessionEntry, 'uuid' | 'timestamp'> {
  return {
    ...entry,
    uuid: randomUUID(),
    timestamp: createAgentCoreSessionTimestamp()
  }
}

// 构造 session metadata entry。metadata 是 session 文件的第一条稳定记录。
export function createAgentCoreMetadataEntry(
  metadata: AgentCoreSessionMetadata
): AgentCoreSessionEntry {
  return withAgentCoreSessionEntryEnvelope({
    kind: 'session-metadata',
    sessionId: metadata.sessionId,
    cwd: metadata.cwd,
    metadata
  })
}

// 读取当前 transcript 字节长度。文件还没创建时从 0 开始索引。
export async function getExistingAgentCoreTranscriptByteLength(
  transcriptPath: string
): Promise<number> {
  try {
    return (await stat(transcriptPath)).size
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return 0
    }
    throw error
  }
}
