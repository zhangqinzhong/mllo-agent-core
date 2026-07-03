import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCoreToolProgress } from './agent-core-tool-types'
import type { createAgentCoreShellTaskOutput } from './shell-task-output'

// 生成 shell 输出文件路径。后台任务必须落盘，否则 GUI 关闭后就丢输出。
export async function createAgentCoreShellOutputTarget(outputDir?: string): Promise<{
  taskId: string
  outputPath: string
  cwdPath: string
}> {
  const taskId = randomUUID()
  const dir = outputDir ?? join(tmpdir(), 'mllo-agent-core-shell')
  await mkdir(dir, {
    recursive: true
  })
  return {
    taskId,
    outputPath: join(dir, `${taskId}.log`),
    cwdPath: join(dir, `${taskId}.cwd`)
  }
}

// 把输出片段追加到任务输出。内存给模型结果，文件给长任务/大输出读取。
export function appendAgentCoreShellOutputProgress(args: {
  stream: 'stdout' | 'stderr'
  chunk: string
  output: Awaited<ReturnType<typeof createAgentCoreShellTaskOutput>>
  startedAt: number
  taskId: string
  onProgress?: (progress: AgentCoreToolProgress) => void
}): void {
  if (args.chunk.length === 0) {
    return
  }
  args.output.append(args.stream, args.chunk)
  const snapshot = args.output.snapshot()
  args.onProgress?.({
    kind: 'shell-output',
    stream: args.stream,
    chunk: args.chunk,
    fullOutput: snapshot.combined,
    elapsedMs: Date.now() - args.startedAt,
    totalBytes: snapshot.totalBytes,
    taskId: args.taskId
  })
}
