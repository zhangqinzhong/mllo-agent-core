import type {
  AgentCoreWorker,
  AgentCoreWorkerAvailabilityCheckResult
} from '../workers/agent-core-worker-types'
import type { AgentCoreToolAvailabilityPolicy } from './agent-core-tool-types'

export type AgentCoreWorkerAvailabilitySummary = {
  availableWorkers: AgentCoreWorker[]
  unavailableWorkers: {
    worker: AgentCoreWorker
    reason: string
  }[]
}

// 中文注释：单个 worker 没声明 availability 时按可用处理，保持旧 worker 兼容。
export async function checkAgentCoreWorkerAvailability(
  worker: AgentCoreWorker
): Promise<AgentCoreWorkerAvailabilityCheckResult> {
  const check = worker.availability?.check
  if (check === undefined) {
    return {
      available: true
    }
  }
  try {
    return await check()
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

// 中文注释：汇总 worker 可用性，delegate/workflow 工具只要至少一个 worker 可用就保留。
export async function summarizeAgentCoreWorkerAvailability(
  workers: readonly AgentCoreWorker[]
): Promise<AgentCoreWorkerAvailabilitySummary> {
  const results = await Promise.all(
    workers.map(async (worker) => ({
      worker,
      result: await checkAgentCoreWorkerAvailability(worker)
    }))
  )
  return {
    availableWorkers: results.filter((item) => item.result.available).map((item) => item.worker),
    unavailableWorkers: results
      .filter((item) => !item.result.available)
      .map((item) => ({
        worker: item.worker,
        reason: item.result.reason ?? 'availability check returned unavailable'
      }))
  }
}

// 中文注释：把 worker 集合的 health check 映射成工具可用性，供 context builder 过滤 schema。
export function createAgentCoreWorkerToolAvailability(
  workers: readonly AgentCoreWorker[]
): AgentCoreToolAvailabilityPolicy {
  const ttlMsValues = workers
    .map((worker) => worker.availability?.ttlMs)
    .filter((value): value is number => value !== undefined)
  const failureGraceMsValues = workers
    .map((worker) => worker.availability?.failureGraceMs)
    .filter((value): value is number => value !== undefined)
  return {
    ...(ttlMsValues.length === 0 ? {} : { ttlMs: Math.min(...ttlMsValues) }),
    ...(failureGraceMsValues.length === 0
      ? {}
      : { failureGraceMs: Math.max(...failureGraceMsValues) }),
    async check() {
      const summary = await summarizeAgentCoreWorkerAvailability(workers)
      if (summary.availableWorkers.length > 0) {
        const unavailableText =
          summary.unavailableWorkers.length === 0
            ? undefined
            : `Unavailable workers: ${summary.unavailableWorkers
                .map((item) => `${item.worker.id} (${item.reason})`)
                .join(', ')}.`
        return {
          available: true,
          reason: unavailableText
        }
      }
      return {
        available: false,
        reason:
          summary.unavailableWorkers.length === 0
            ? 'No worker agents are registered.'
            : `No worker agents are available: ${summary.unavailableWorkers
                .map((item) => `${item.worker.id} (${item.reason})`)
                .join(', ')}.`
      }
    }
  }
}
