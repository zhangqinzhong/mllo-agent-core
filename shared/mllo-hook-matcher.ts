import type { MlloHookMatcher } from './mllo-hook-protocol'

export type MlloHookMatcherContext = {
  toolName?: string
  filePaths?: readonly string[]
  cwd?: string
  userPrompt?: string
  workerId?: string
}

export type MlloHookMatcherPreview = {
  summary: string
  warnings: string[]
}

// 中文注释：路径 matcher 统一用 `/`，这样 Windows 路径也能按同一套配置预览和命中。
export function normalizeMlloHookMatcherText(value: string): string {
  return value.replaceAll('\\', '/')
}

// 中文注释：只支持 * 和 ?，避免 hook matcher 变成任意正则表达式执行面。
export function mlloHookSimpleGlobToRegExp(pattern: string): RegExp {
  const escaped = normalizeMlloHookMatcherText(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const source = escaped.replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${source}$`)
}

// 中文注释：没有配置 patterns 表示该维度不限制；配置了就必须有值并命中。
export function matchesMlloHookPattern(
  value: string | undefined,
  patterns: readonly string[] | undefined
): boolean {
  if (patterns === undefined) {
    return true
  }
  if (value === undefined) {
    return false
  }
  const normalized = normalizeMlloHookMatcherText(value)
  return patterns.some((pattern) => mlloHookSimpleGlobToRegExp(pattern).test(normalized))
}

// 中文注释：prompt matcher 用包含关系，比 glob 更符合“用户提示词包含某段话”的直觉。
export function includesMlloHookText(
  value: string | undefined,
  needles: readonly string[] | undefined
): boolean {
  if (needles === undefined) {
    return true
  }
  if (value === undefined) {
    return false
  }
  return needles.some((needle) => value.includes(needle))
}

// 中文注释：路径候选可能来自 file-change 或工具 input，任一命中即可通过该维度。
export function matchesMlloHookPathCandidates(
  candidates: readonly string[] | undefined,
  patterns: readonly string[] | undefined
): boolean {
  if (patterns === undefined) {
    return true
  }
  return (candidates ?? []).some((candidate) => matchesMlloHookPattern(candidate, patterns))
}

// 中文注释：所有已配置 matcher 维度都必须满足，和 mllo command hook 运行时规则一致。
export function matchesMlloHookMatcher(
  matcher: MlloHookMatcher | undefined,
  context: MlloHookMatcherContext
): boolean {
  if (matcher === undefined) {
    return true
  }
  return (
    matchesMlloHookPattern(context.toolName, matcher.toolNames) &&
    matchesMlloHookPathCandidates(context.filePaths, matcher.filePathGlobs) &&
    matchesMlloHookPattern(context.cwd, matcher.cwdGlobs) &&
    includesMlloHookText(context.userPrompt, matcher.userPromptIncludes) &&
    matchesMlloHookPattern(context.workerId, matcher.workerIds)
  )
}

// 中文注释：把 matcher 压成可读摘要，设置页和编辑器共用同一套展示顺序。
export function describeMlloHookMatcher(
  matcher: MlloHookMatcher | undefined
): MlloHookMatcherPreview {
  if (matcher === undefined || Object.keys(matcher).length === 0) {
    return {
      summary: 'Matches all hook contexts',
      warnings: []
    }
  }
  const parts = [
    matcher.toolNames?.length ? `tools: ${matcher.toolNames.join(', ')}` : null,
    matcher.filePathGlobs?.length ? `files: ${matcher.filePathGlobs.join(', ')}` : null,
    matcher.cwdGlobs?.length ? `cwd: ${matcher.cwdGlobs.join(', ')}` : null,
    matcher.userPromptIncludes?.length
      ? `prompt includes: ${matcher.userPromptIncludes.join(', ')}`
      : null,
    matcher.workerIds?.length ? `workers: ${matcher.workerIds.join(', ')}` : null
  ].filter((part): part is string => part !== null)
  return {
    summary: parts.length > 0 ? parts.join(' · ') : 'Matches all hook contexts',
    warnings: collectMlloHookMatcherWarnings(matcher)
  }
}

// 中文注释：预览层只提示容易误解的配置，不阻断保存；真正合法性仍由 main schema 校验。
function collectMlloHookMatcherWarnings(matcher: MlloHookMatcher): string[] {
  const warnings: string[] = []
  const globEntries = [
    ...(matcher.filePathGlobs ?? []),
    ...(matcher.cwdGlobs ?? []),
    ...(matcher.toolNames ?? []),
    ...(matcher.workerIds ?? [])
  ]
  if (globEntries.some((entry) => entry.includes('\\'))) {
    warnings.push('Backslashes are normalized to /.')
  }
  if (matcher.filePathGlobs?.some((entry) => !entry.includes('/') && !entry.includes('*'))) {
    warnings.push('File globs without / or * match only the exact candidate path.')
  }
  return warnings
}
