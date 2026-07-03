import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type AgentCoreCheckpointFileSnapshot = {
  path: string
  resolvedPath: string
  previousContent: string | null
  contentAfterWrite?: string
}

export type AgentCoreCheckpointRecord = {
  checkpointId: string
  sessionId: string
  cwd: string
  prompt: string
  createdAt: string
  files: AgentCoreCheckpointFileSnapshot[]
}

export type AgentCoreCheckpointStoreOptions = {
  checkpointsDir: string
  sessionId: string
  cwd: string
  prompt: string
  checkpointId?: string
}

export type AgentCoreCheckpointSnapshotInput = AgentCoreCheckpointFileSnapshot
export type AgentCoreCheckpointWriteInput = {
  path: string
  resolvedPath: string
  contentAfterWrite: string
}

// 每个 run 一个 checkpoint record；写工具只记录首次触碰文件的旧内容。
export class AgentCoreCheckpointStore {
  private readonly record: AgentCoreCheckpointRecord
  private readonly checkpointPath: string
  private readonly seenPaths = new Set<string>()

  // 初始化一次 run 的 checkpoint。checkpointId 固定后，后续文件快照都归入同一记录。
  constructor(options: AgentCoreCheckpointStoreOptions) {
    const checkpointId = options.checkpointId ?? randomUUID()
    this.record = {
      checkpointId,
      sessionId: options.sessionId,
      cwd: options.cwd,
      prompt: options.prompt,
      createdAt: new Date().toISOString(),
      files: []
    }
    this.checkpointPath = join(options.checkpointsDir, `${checkpointId}.json`)
  }

  // 暴露 checkpoint 文件路径。provider 需要把它写入 GUI/JSONL，供用户后续恢复。
  path(): string {
    return this.checkpointPath
  }

  // 返回当前已记录的文件数。测试用它确认重复文件不会制造多份快照。
  snapshotCount(): number {
    return this.record.files.length
  }

  // 写工具可能多次改同一文件；rewind 只需要该 run 开始时的第一次旧内容。
  async snapshotFile(input: AgentCoreCheckpointSnapshotInput): Promise<void> {
    if (this.seenPaths.has(input.resolvedPath)) {
      return
    }
    this.seenPaths.add(input.resolvedPath)
    this.record.files.push({
      path: input.path,
      resolvedPath: input.resolvedPath,
      previousContent: input.previousContent
    })
    await this.persist()
  }

  // 写成功后记录 agent 实际写出的内容；恢复前用它判断文件是否又被用户改过。
  async recordFileWrite(input: AgentCoreCheckpointWriteInput): Promise<void> {
    const existing = this.record.files.find((file) => file.resolvedPath === input.resolvedPath)
    if (existing === undefined) {
      return
    }
    existing.contentAfterWrite = input.contentAfterWrite
    await this.persist()
  }

  // 原子写入 checkpoint 文件。中途崩溃时不能留下半截 JSON 破坏恢复。
  private async persist(): Promise<void> {
    await mkdir(dirname(this.checkpointPath), {
      recursive: true
    })
    const tmpPath = `${this.checkpointPath}.${process.pid}.tmp`
    await writeFile(tmpPath, `${JSON.stringify(this.record, null, 2)}\n`, 'utf8')
    try {
      await rename(tmpPath, this.checkpointPath)
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code !== 'EEXIST'
      ) {
        throw error
      }
      // Windows 可能拒绝覆盖式 rename；失败时先删除旧文件再替换。
      await rm(this.checkpointPath, {
        force: true
      })
      await rename(tmpPath, this.checkpointPath)
    }
  }
}
