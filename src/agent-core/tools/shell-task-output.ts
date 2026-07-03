import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type AgentCoreShellTaskOutputSnapshot = {
  path: string
  stdout: string
  stderr: string
  combined: string
  totalBytes: number
}

export type AgentCoreShellTaskOutput = {
  path: string
  append: (stream: 'stdout' | 'stderr', text: string) => void
  snapshot: () => AgentCoreShellTaskOutputSnapshot
  close: () => Promise<void>
}

// 创建 shell 输出收集器。内存用于模型结果，文件用于后台任务和 GUI 持续读取。
export async function createAgentCoreShellTaskOutput(
  outputPath: string
): Promise<AgentCoreShellTaskOutput> {
  await mkdir(dirname(outputPath), {
    recursive: true
  })
  const writeStream = createWriteStream(outputPath, {
    encoding: 'utf8'
  })
  const output = {
    stdout: '',
    stderr: '',
    combined: ''
  }

  return {
    path: outputPath,
    append(stream, text) {
      output[stream] += text
      output.combined += text
      writeStream.write(`[${stream}] ${text}`)
    },
    snapshot() {
      return {
        path: outputPath,
        stdout: output.stdout,
        stderr: output.stderr,
        combined: output.combined,
        totalBytes: Buffer.byteLength(output.combined)
      }
    },
    async close() {
      await closeAgentCoreShellOutputStream(writeStream)
    }
  }
}

// 关闭输出流。Node 的 WriteStream.end 是回调式 API，这里转成 Promise 便于 runner 等待。
function closeAgentCoreShellOutputStream(writeStream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    writeStream.end(resolve)
  })
}

// 从输出文件读取尾部文本。GUI 查询后台任务时不应该一次读入超大日志。
export async function readAgentCoreShellTaskOutputTail(
  outputPath: string,
  maxChars: number
): Promise<string> {
  const content = await readFile(outputPath, 'utf8')
  return content.length > maxChars ? content.slice(content.length - maxChars) : content
}
