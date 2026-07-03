type AgentCoreFileLine = {
  lineNumber: number
  startOffset: number
  endOffset: number
  text: string
}

export type AgentCoreEditFailureMessageArgs = {
  path: string
  content: string
  oldText: string
  reason: string
}

const DEFAULT_CONTEXT_RADIUS = 2
const DEFAULT_MAX_CONTEXTS = 5
const DEFAULT_FALLBACK_LINES = 20

function createFileLines(content: string): AgentCoreFileLine[] {
  const lines = content.split(/\r?\n/)
  const result: AgentCoreFileLine[] = []
  let offset = 0
  for (const [index, text] of lines.entries()) {
    result.push({
      lineNumber: index + 1,
      startOffset: offset,
      endOffset: offset + text.length,
      text
    })
    offset += text.length + 1
  }
  return result
}

function findOffsets(content: string, target: string, limit: number): number[] {
  const offsets: number[] = []
  let offset = 0
  while (offset < content.length && offsets.length < limit) {
    const index = content.indexOf(target, offset)
    if (index === -1) {
      return offsets
    }
    offsets.push(index)
    offset = index + target.length
  }
  return offsets
}

function lineIndexForOffset(lines: readonly AgentCoreFileLine[], offset: number): number {
  const index = lines.findIndex((line) => offset >= line.startOffset && offset <= line.endOffset)
  return Math.max(index, 0)
}

function renderLineWindow(
  lines: readonly AgentCoreFileLine[],
  centerIndex: number,
  radius = DEFAULT_CONTEXT_RADIUS
): string {
  const start = Math.max(centerIndex - radius, 0)
  const end = Math.min(centerIndex + radius + 1, lines.length)
  return lines
    .slice(start, end)
    .map((line) => `${line.lineNumber.toString().padStart(4, ' ')} | ${line.text}`)
    .join('\n')
}

function renderExactMatchContexts(args: {
  content: string
  lines: readonly AgentCoreFileLine[]
  oldText: string
}): string | null {
  const offsets = findOffsets(args.content, args.oldText, DEFAULT_MAX_CONTEXTS + 1)
  if (offsets.length === 0) {
    return null
  }
  const visibleOffsets = offsets.slice(0, DEFAULT_MAX_CONTEXTS)
  const suffix =
    offsets.length > DEFAULT_MAX_CONTEXTS ? `\n... more matches not shown; narrow oldText.` : ''
  return [
    'Current exact-match contexts:',
    ...visibleOffsets.map((offset, index) =>
      [
        `Match ${index + 1}:`,
        renderLineWindow(args.lines, lineIndexForOffset(args.lines, offset))
      ].join('\n')
    ),
    suffix
  ]
    .filter((item) => item.length > 0)
    .join('\n\n')
}

function findBestAnchor(oldText: string): string | null {
  const candidates = oldText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4)
    .sort((left, right) => right.length - left.length)
  return candidates[0] ?? null
}

function renderAnchorContext(args: {
  content: string
  lines: readonly AgentCoreFileLine[]
  oldText: string
}): string | null {
  const anchor = findBestAnchor(args.oldText)
  if (anchor === null) {
    return null
  }
  const offsets = findOffsets(args.content, anchor, DEFAULT_MAX_CONTEXTS + 1)
  if (offsets.length === 0) {
    return null
  }
  const visibleOffsets = offsets.slice(0, DEFAULT_MAX_CONTEXTS)
  const suffix =
    offsets.length > DEFAULT_MAX_CONTEXTS
      ? `\n... more anchor matches not shown; read the file and retry with exact current text.`
      : ''
  return [
    `Closest contexts using oldText line: ${JSON.stringify(anchor)}`,
    ...visibleOffsets.map((offset, index) =>
      [
        `Anchor ${index + 1}:`,
        renderLineWindow(args.lines, lineIndexForOffset(args.lines, offset))
      ].join('\n')
    ),
    suffix
  ]
    .filter((item) => item.length > 0)
    .join('\n\n')
}

function renderFallbackExcerpt(lines: readonly AgentCoreFileLine[]): string {
  const visibleLines = lines.slice(0, DEFAULT_FALLBACK_LINES)
  const suffix =
    lines.length > DEFAULT_FALLBACK_LINES
      ? `\n... ${lines.length - DEFAULT_FALLBACK_LINES} more lines not shown; read the file and retry.`
      : ''
  return [
    'Current file excerpt:',
    visibleLines
      .map((line) => `${line.lineNumber.toString().padStart(4, ' ')} | ${line.text}`)
      .join('\n'),
    suffix
  ]
    .filter((item) => item.length > 0)
    .join('\n')
}

// 工具失败时给模型当前文件上下文，避免只返回“没匹配”导致模型无法自我修正。
export function createAgentCoreEditFailureMessage(args: AgentCoreEditFailureMessageArgs): string {
  const lines = createFileLines(args.content)
  const context =
    renderExactMatchContexts({
      content: args.content,
      lines,
      oldText: args.oldText
    }) ??
    renderAnchorContext({
      content: args.content,
      lines,
      oldText: args.oldText
    }) ??
    renderFallbackExcerpt(lines)
  return `${args.reason}\n\n${context}`
}
