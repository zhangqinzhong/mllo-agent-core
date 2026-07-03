import { readFile, unlink } from 'node:fs/promises'
import type { AgentCoreShellCwdChange, AgentCoreShellCwdTracker } from './shell-cwd-tracker'

// 按当前平台转义临时 cwd 文件路径。它只包我们生成的路径，不处理用户命令。
function quoteShellPath(filePath: string): string {
  if (process.platform === 'win32') {
    return `"${filePath.replaceAll('"', '""')}"`
  }
  return `'${filePath.replaceAll("'", "'\\''")}'`
}

// 在用户命令后追加 cwd 文件记录，同时保留原始 exit code。
export function wrapAgentCoreShellCommandForCwdFileTracking(
  command: string,
  cwdPath: string
): string {
  const quotedCwdPath = quoteShellPath(cwdPath)
  if (process.platform === 'win32') {
    return `${command}\nset "__mllo_exit=%ERRORLEVEL%"\ncd > ${quotedCwdPath}\nexit /b %__mllo_exit%`
  }
  return `${command}\n__mllo_exit=$?\npwd -P > ${quotedCwdPath}\nexit $__mllo_exit`
}

// 在用户命令后追加 stdout marker。远程 SSH 后端不能写本机 cwd 文件，只能走输出控制段。
export function wrapAgentCoreShellCommandForStdoutCwdTracking(args: {
  command: string
  startMarker: string
  endMarker: string
}): string {
  if (process.platform === 'win32') {
    return [
      args.command,
      'set "__mllo_exit=%ERRORLEVEL%"',
      `echo ${args.startMarker}`,
      'cd',
      `echo ${args.endMarker}`,
      'exit /b %__mllo_exit%'
    ].join('\n')
  }
  return [
    args.command,
    '__mllo_exit=$?',
    `printf '\\n${args.startMarker}\\n'`,
    'pwd -P',
    `printf '${args.endMarker}\\n'`,
    'exit $__mllo_exit'
  ].join('\n')
}

async function readTrackedShellCwd(cwdPath: string): Promise<string | undefined> {
  const content = await readFile(cwdPath, 'utf8').catch(() => undefined)
  await unlink(cwdPath).catch(() => undefined)
  const trimmed = content?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

// 前台命令结束后更新 shell cwd。后台任务不会调用这里，避免异步任务乱改会话目录。
export async function updateAgentCoreShellCwdFromFile(args: {
  cwdPath: string
  cwdTracker?: AgentCoreShellCwdTracker
}): Promise<AgentCoreShellCwdChange | undefined> {
  const cwd = await readTrackedShellCwd(args.cwdPath)
  return cwd === undefined ? undefined : args.cwdTracker?.setCwd(cwd)
}

export function updateAgentCoreShellCwdFromTrackedValue(args: {
  cwd: string | undefined
  cwdTracker?: AgentCoreShellCwdTracker
}): AgentCoreShellCwdChange | undefined {
  return args.cwd === undefined ? undefined : args.cwdTracker?.setCwd(args.cwd)
}

function longestSuffixMatchingPrefix(text: string, prefix: string): number {
  const maxLength = Math.min(text.length, prefix.length - 1)
  for (let length = maxLength; length > 0; length -= 1) {
    if (prefix.startsWith(text.slice(text.length - length))) {
      return length
    }
  }
  return 0
}

export function createAgentCoreStdoutCwdMarkerParser(args: {
  startMarker: string
  endMarker: string
}) {
  let buffer = ''
  let capturing = false
  let captured = ''
  let cwd: string | undefined
  return {
    consume(text: string): string {
      buffer += text
      let visible = ''
      while (buffer.length > 0) {
        if (!capturing) {
          const markerIndex = buffer.indexOf(args.startMarker)
          if (markerIndex === -1) {
            const keepLength = longestSuffixMatchingPrefix(buffer, args.startMarker)
            visible += buffer.slice(0, buffer.length - keepLength)
            buffer = buffer.slice(buffer.length - keepLength)
            break
          }
          visible += buffer.slice(0, markerIndex)
          buffer = buffer.slice(markerIndex + args.startMarker.length)
          capturing = true
          captured = ''
          continue
        }

        const endIndex = buffer.indexOf(args.endMarker)
        if (endIndex === -1) {
          captured += buffer
          buffer = ''
          break
        }
        captured += buffer.slice(0, endIndex)
        cwd = captured.trim() || cwd
        buffer = buffer.slice(endIndex + args.endMarker.length)
        capturing = false
        captured = ''
      }
      return visible
    },
    flush(): string {
      if (capturing) {
        return ''
      }
      const visible = buffer
      buffer = ''
      return visible
    },
    getCwd(): string | undefined {
      return cwd
    }
  }
}
