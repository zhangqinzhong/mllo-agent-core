import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentCoreShellTaskRecord } from './shell-task-registry'

export type AgentCoreShellTaskJournalEntry = {
  kind: 'shell-task'
  recordedAt: number
  task: AgentCoreShellTaskRecord
}

function serializeShellTaskEntry(entry: AgentCoreShellTaskJournalEntry): string {
  return `${JSON.stringify(entry)}\n`
}

function parseShellTaskJournal(content: string): AgentCoreShellTaskJournalEntry[] {
  const entries: AgentCoreShellTaskJournalEntry[] = []
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line.length === 0) {
      continue
    }
    entries.push(JSON.parse(line) as AgentCoreShellTaskJournalEntry)
  }
  return entries
}

// 追加 shell task 状态快照。后台命令必须可恢复查询，不能只留在内存 registry。
export async function appendAgentCoreShellTaskJournalEntry(args: {
  journalPath: string
  task: AgentCoreShellTaskRecord
}): Promise<void> {
  await mkdir(dirname(args.journalPath), {
    recursive: true
  })
  await appendFile(
    args.journalPath,
    serializeShellTaskEntry({
      kind: 'shell-task',
      recordedAt: Date.now(),
      task: args.task
    }),
    'utf8'
  )
}

// 读取每个 taskId 的最新快照。JSONL 保留历史，registry 查询只需要当前状态。
export async function readLatestAgentCoreShellTaskJournal(args: {
  journalPath: string
}): Promise<AgentCoreShellTaskRecord[]> {
  const content = await readFile(args.journalPath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return ''
    }
    throw error
  })
  const latest = new Map<string, AgentCoreShellTaskRecord>()
  for (const entry of parseShellTaskJournal(content)) {
    latest.set(entry.task.taskId, entry.task)
  }
  return Array.from(latest.values())
}
