import type { MlloHookMatcher } from "./agent-core-command-hook-protocol";

export type MlloHookMatcherContext = {
  toolName?: string;
  filePaths?: readonly string[];
  cwd?: string;
  userPrompt?: string;
  workerId?: string;
};

// 路径 matcher 统一用 `/`，这样 Windows 路径也能按同一套配置预览和命中。
function normalizeMlloHookMatcherText(value: string): string {
  return value.replaceAll("\\", "/");
}

// 只支持 * 和 ?，避免 hook matcher 变成任意正则表达式执行面。
function mlloHookSimpleGlobToRegExp(pattern: string): RegExp {
  const escaped = normalizeMlloHookMatcherText(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${source}$`);
}

// 没有配置 patterns 表示该维度不限制；配置了就必须有值并命中。
function matchesMlloHookPattern(
  value: string | undefined,
  patterns: readonly string[] | undefined,
): boolean {
  if (patterns === undefined) {
    return true;
  }
  if (value === undefined) {
    return false;
  }
  const normalized = normalizeMlloHookMatcherText(value);
  return patterns.some((pattern) => mlloHookSimpleGlobToRegExp(pattern).test(normalized));
}

// prompt matcher 用包含关系，比 glob 更符合“用户提示词包含某段话”的直觉。
function includesMlloHookText(
  value: string | undefined,
  needles: readonly string[] | undefined,
): boolean {
  if (needles === undefined) {
    return true;
  }
  if (value === undefined) {
    return false;
  }
  return needles.some((needle) => value.includes(needle));
}

// 路径候选可能来自 file-change 或工具 input，任一命中即可通过该维度。
function matchesMlloHookPathCandidates(
  candidates: readonly string[] | undefined,
  patterns: readonly string[] | undefined,
): boolean {
  if (patterns === undefined) {
    return true;
  }
  return (candidates ?? []).some((candidate) => matchesMlloHookPattern(candidate, patterns));
}

// 所有已配置 matcher 维度都必须满足，和 mllo command hook 运行时规则一致。
export function matchesMlloHookMatcher(
  matcher: MlloHookMatcher | undefined,
  context: MlloHookMatcherContext,
): boolean {
  if (matcher === undefined) {
    return true;
  }
  return (
    matchesMlloHookPattern(context.toolName, matcher.toolNames) &&
    matchesMlloHookPathCandidates(context.filePaths, matcher.filePathGlobs) &&
    matchesMlloHookPattern(context.cwd, matcher.cwdGlobs) &&
    includesMlloHookText(context.userPrompt, matcher.userPromptIncludes) &&
    matchesMlloHookPattern(context.workerId, matcher.workerIds)
  );
}
