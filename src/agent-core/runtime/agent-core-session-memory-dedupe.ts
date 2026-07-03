export type AgentCoreSessionMemoryDedupeResult = {
  memory: string
  removedDuplicateLines: number
}

// 归一化 memory 行。去重只比对稳定事实文本，不让 markdown 空格差异制造重复。
function normalizeMemoryLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

// 判断一行是否是可去重事实。metadata/header 不参与去重，避免误删来源信息。
function isDedupeCandidate(line: string): boolean {
  const normalized = normalizeMemoryLine(line)
  return (
    normalized.length > 0 &&
    !normalized.startsWith('## ') &&
    !normalized.startsWith('- sessionId:') &&
    !normalized.startsWith('- cwd:') &&
    !normalized.startsWith('- compactId:') &&
    !normalized.startsWith('- summarizedMessageCount:')
  )
}

// 从已有 MEMORY.md 中收集事实行。这里做精确归一化去重，先保持可解释和低风险。
function collectExistingMemoryFacts(existingMemory: string): Set<string> {
  const facts = new Set<string>()
  for (const line of existingMemory.split(/\r?\n/)) {
    if (isDedupeCandidate(line)) {
      facts.add(normalizeMemoryLine(line))
    }
  }
  return facts
}

// 对 extractor 输出做行级去重。返回空 memory 表示本次没有新增长期事实。
export function dedupeAgentCoreSessionMemory(args: {
  existingMemory: string
  extractedMemory: string
}): AgentCoreSessionMemoryDedupeResult {
  const existingFacts = collectExistingMemoryFacts(args.existingMemory)
  const keptLines: string[] = []
  let removedDuplicateLines = 0

  for (const line of args.extractedMemory.split(/\r?\n/)) {
    if (!isDedupeCandidate(line)) {
      keptLines.push(line)
      continue
    }
    const normalized = normalizeMemoryLine(line)
    if (existingFacts.has(normalized)) {
      removedDuplicateLines += 1
      continue
    }
    existingFacts.add(normalized)
    keptLines.push(line)
  }

  return {
    memory: keptLines.join('\n').trim(),
    removedDuplicateLines
  }
}
