import type {
  AgentCoreHookContext,
  AgentCoreHookDefinition,
  AgentCoreHookEvent,
  AgentCoreHookRunResult
} from './agent-core-hook-types'

// 把未知 hook 异常转成文本。hook 失败要进入审计记录，不能只留在控制台。
function hookErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 按 phase 和 matcher 过滤 hook。未命中 matcher 的 hook 不产出 timeline 事件。
function hooksForContext(
  hooks: readonly AgentCoreHookDefinition[],
  context: AgentCoreHookContext
): AgentCoreHookDefinition[] {
  return hooks.filter((hook) => hook.phase === context.phase && (hook.shouldRun?.(context) ?? true))
}

// 合并 hook 决策。block 优先，其次 request-continue，默认继续。
function mergeHookDecision(
  current: AgentCoreHookRunResult,
  next: AgentCoreHookRunResult
): AgentCoreHookRunResult {
  const failed = current.failed === true || next.failed === true
  if (current.action === 'block' || next.action === 'continue') {
    return {
      ...current,
      failed
    }
  }
  if (next.action === 'block') {
    return {
      ...next,
      failed
    }
  }
  if (current.action === 'request-continue') {
    return {
      ...current,
      failed
    }
  }
  return {
    ...next,
    failed
  }
}

// 把单个 hook 返回值规整成统一决策。未返回表示普通 continue。
function normalizeHookDecision(
  value: Awaited<ReturnType<AgentCoreHookDefinition['run']>>
): AgentCoreHookRunResult {
  if (value === undefined || value.action === 'continue') {
    return {
      action: 'continue',
      reason: value?.content
    }
  }
  return {
    action: value.action,
    reason: value.reason
  }
}

// 执行指定 phase 的 hooks。事件边跑边产出，便于 GUI 和 JSONL 看到 hook 进度。
export async function* runAgentCoreHooks(args: {
  hooks: readonly AgentCoreHookDefinition[]
  context: AgentCoreHookContext
}): AsyncGenerator<AgentCoreHookEvent, AgentCoreHookRunResult> {
  let decision: AgentCoreHookRunResult = {
    action: 'continue'
  }

  for (const hook of hooksForContext(args.hooks, args.context)) {
    yield {
      type: 'hook-event',
      hookName: hook.name,
      phase: hook.phase,
      status: 'started'
    }

    try {
      const result = normalizeHookDecision(await hook.run(args.context))
      decision = mergeHookDecision(decision, result)
      yield {
        type: 'hook-event',
        hookName: hook.name,
        phase: hook.phase,
        status: 'completed',
        content: result.reason
      }
    } catch (error) {
      const content = hookErrorMessage(error)
      decision = mergeHookDecision(decision, {
        action: 'block',
        reason: content,
        failed: true
      })
      yield {
        type: 'hook-event',
        hookName: hook.name,
        phase: hook.phase,
        status: 'failed',
        content
      }
    }
  }

  return decision
}
