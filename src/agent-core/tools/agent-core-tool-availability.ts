import type {
  AgentCoreToolAvailabilityCheckResult,
  AgentCoreToolDefinition
} from './agent-core-tool-types'

const DEFAULT_TOOL_AVAILABILITY_TTL_MS = 60_000
const DEFAULT_TOOL_AVAILABILITY_FAILURE_GRACE_MS = 5 * 60_000

type AgentCoreToolAvailabilityCachedEntry = {
  checkedAtMs: number
  result: AgentCoreToolAvailabilityCheckResult
  lastAvailableAtMs?: number
}

export type AgentCoreToolAvailabilityStatus = 'available' | 'grace' | 'unavailable'

export type AgentCoreToolAvailabilityRecord = {
  toolName: string
  status: AgentCoreToolAvailabilityStatus
  visible: boolean
  checkedAtMs: number
  reason?: string
  lastAvailableAtMs?: number
}

export type AgentCoreToolAvailabilityResolution = {
  tools: AgentCoreToolDefinition[]
  records: AgentCoreToolAvailabilityRecord[]
}

// 工具可用性缓存。它保留 last-good，避免一次探测失败立刻改变模型 schema。
export class AgentCoreToolAvailabilityCache {
  private readonly entries = new Map<string, AgentCoreToolAvailabilityCachedEntry>()

  // 清空缓存。测试和运行态重载配置时使用，避免旧探测结果泄漏到新环境。
  clear(): void {
    this.entries.clear()
  }

  // 读取或刷新工具可用性。没有 check 的内置工具默认稳定可见。
  async resolveTool(args: {
    tool: AgentCoreToolDefinition
    nowMs?: number
  }): Promise<AgentCoreToolAvailabilityRecord> {
    const nowMs = args.nowMs ?? Date.now()
    const check = args.tool.availability?.check
    if (check === undefined) {
      return {
        toolName: args.tool.name,
        status: 'available',
        visible: true,
        checkedAtMs: nowMs
      }
    }

    const ttlMs = args.tool.availability?.ttlMs ?? DEFAULT_TOOL_AVAILABILITY_TTL_MS
    const failureGraceMs =
      args.tool.availability?.failureGraceMs ?? DEFAULT_TOOL_AVAILABILITY_FAILURE_GRACE_MS
    const cacheKey = this.getCacheKey(args.tool)
    const cached = this.entries.get(cacheKey)
    if (cached !== undefined && nowMs - cached.checkedAtMs <= ttlMs) {
      return this.recordFromCached({
        toolName: args.tool.name,
        cached,
        nowMs,
        failureGraceMs
      })
    }

    const result = await this.runCheck(check)
    const entry: AgentCoreToolAvailabilityCachedEntry = {
      checkedAtMs: nowMs,
      result,
      lastAvailableAtMs: result.available ? nowMs : cached?.lastAvailableAtMs
    }
    this.entries.set(cacheKey, entry)
    return this.recordFromCached({
      toolName: args.tool.name,
      cached: entry,
      nowMs,
      failureGraceMs
    })
  }

  // 同名工具可能因为 backend 或安全策略不同而可用性不同，缓存必须区分这些运行态。
  private getCacheKey(tool: AgentCoreToolDefinition): string {
    return tool.availability?.cacheKey ?? tool.name
  }

  // 执行 check，异常也转成 unavailable 记录，避免探测失败中断整轮 context 构建。
  private async runCheck(
    check: NonNullable<AgentCoreToolDefinition['availability']>['check']
  ): Promise<AgentCoreToolAvailabilityCheckResult> {
    try {
      const result = await check?.()
      return (
        result ?? {
          available: false,
          reason: 'availability check returned no result'
        }
      )
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  // 把缓存态转换成当前可见性。failureGrace 只基于最近一次成功探测计算。
  private recordFromCached(args: {
    toolName: string
    cached: AgentCoreToolAvailabilityCachedEntry
    nowMs: number
    failureGraceMs: number
  }): AgentCoreToolAvailabilityRecord {
    const { toolName, cached, nowMs, failureGraceMs } = args
    if (cached.result.available) {
      return {
        toolName,
        status: 'available',
        visible: true,
        checkedAtMs: cached.checkedAtMs,
        reason: cached.result.reason,
        lastAvailableAtMs: cached.lastAvailableAtMs
      }
    }

    const inGrace =
      cached.lastAvailableAtMs !== undefined && nowMs - cached.lastAvailableAtMs <= failureGraceMs
    return {
      toolName,
      status: inGrace ? 'grace' : 'unavailable',
      visible: inGrace,
      checkedAtMs: cached.checkedAtMs,
      reason: cached.result.reason,
      lastAvailableAtMs: cached.lastAvailableAtMs
    }
  }
}

export const defaultAgentCoreToolAvailabilityCache = new AgentCoreToolAvailabilityCache()

// 解析本轮模型可见工具集。不可用且不在 grace 内的工具会从 schema 里隐藏。
export async function resolveAgentCoreToolAvailability(args: {
  tools: readonly AgentCoreToolDefinition[]
  cache?: AgentCoreToolAvailabilityCache
  nowMs?: number
}): Promise<AgentCoreToolAvailabilityResolution> {
  const cache = args.cache ?? defaultAgentCoreToolAvailabilityCache
  const records: AgentCoreToolAvailabilityRecord[] = []
  const visibleTools: AgentCoreToolDefinition[] = []
  for (const tool of args.tools) {
    const record = await cache.resolveTool({
      tool,
      nowMs: args.nowMs
    })
    records.push(record)
    if (record.visible) {
      visibleTools.push(tool)
    }
  }
  return {
    tools: visibleTools,
    records
  }
}
