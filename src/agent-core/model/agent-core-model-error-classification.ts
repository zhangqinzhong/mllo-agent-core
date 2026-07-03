export type AgentCoreModelErrorCode =
  | 'context-length-exceeded'
  | 'rate-limited'
  | 'transient-provider-error'
  | 'network-error'
  | 'provider-error'

// 模型错误要带可重试语义，避免 query loop 只能靠字符串猜是否恢复。
export class AgentCoreModelError extends Error {
  readonly code: AgentCoreModelErrorCode
  readonly retryable: boolean
  readonly status?: number

  // 保存 provider 错误分类和 HTTP 状态码，controller 后续可做统计和恢复策略。
  constructor(args: {
    message: string
    code: AgentCoreModelErrorCode
    retryable: boolean
    status?: number
    cause?: unknown
  }) {
    super(args.message, {
      cause: args.cause
    })
    this.name = 'AgentCoreModelError'
    this.code = args.code
    this.retryable = args.retryable
    if (args.status !== undefined) {
      this.status = args.status
    }
  }
}

const CONTEXT_LENGTH_PATTERNS = [
  /context length/i,
  /context window/i,
  /context limit/i,
  /maximum context/i,
  /messages? too long/i,
  /prompt is too long/i,
  /prompt too long/i,
  /input is too long/i,
  /too many tokens/i,
  /exceeds.*token/i,
  /token.*exceed/i
]

const RATE_LIMIT_PATTERNS = [/rate limit/i, /too many requests/i, /\b429\b/i]

const TRANSIENT_PROVIDER_PATTERNS = [
  /overloaded/i,
  /temporarily unavailable/i,
  /try again/i,
  /server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /\b5\d\d\b/
]

const NETWORK_PATTERNS = [
  /network/i,
  /timeout/i,
  /timed out/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /fetch failed/i
]

// 把未知异常转成字符串。模型 SDK 和 fetch adapter 都可能抛非 Error 值。
function modelErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function matchesAnyPattern(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message))
}

function classifyHttpStatus(status: number): AgentCoreModelErrorCode | undefined {
  if (status === 429) {
    return 'rate-limited'
  }
  if (status === 408 || status >= 500) {
    return 'transient-provider-error'
  }
  return undefined
}

// 判断模型错误类型。controller 只对 context-length 做 compact，retry 层处理 transient。
export function classifyAgentCoreModelError(error: unknown): AgentCoreModelErrorCode | undefined {
  if (error instanceof AgentCoreModelError) {
    return error.code
  }
  const message = modelErrorMessage(error)
  if (matchesAnyPattern(message, CONTEXT_LENGTH_PATTERNS)) {
    return 'context-length-exceeded'
  }
  if (matchesAnyPattern(message, RATE_LIMIT_PATTERNS)) {
    return 'rate-limited'
  }
  if (matchesAnyPattern(message, TRANSIENT_PROVIDER_PATTERNS)) {
    return 'transient-provider-error'
  }
  if (matchesAnyPattern(message, NETWORK_PATTERNS)) {
    return 'network-error'
  }
  return undefined
}

// 暴露统一错误文案提取，避免 query loop 和 controller 各自 stringify。
export function getAgentCoreModelErrorMessage(error: unknown): string {
  return modelErrorMessage(error)
}

export function createAgentCoreModelHttpError(args: {
  message: string
  status: number
}): AgentCoreModelError {
  const code = classifyAgentCoreModelError(args.message) ?? classifyHttpStatus(args.status)
  return new AgentCoreModelError({
    message: args.message,
    code: code ?? 'provider-error',
    retryable: code !== 'context-length-exceeded' && code !== undefined,
    status: args.status
  })
}

export function createAgentCoreModelNetworkError(error: unknown): AgentCoreModelError {
  return new AgentCoreModelError({
    message: modelErrorMessage(error),
    code: 'network-error',
    retryable: true,
    cause: error
  })
}

export function createAgentCoreModelProviderError(args: {
  message: string
  cause?: unknown
  retryable?: boolean
}): AgentCoreModelError {
  return new AgentCoreModelError({
    message: args.message,
    code: 'provider-error',
    retryable: args.retryable ?? false,
    cause: args.cause
  })
}

export function isAgentCoreRetryableModelError(error: unknown): boolean {
  if (error instanceof AgentCoreModelError) {
    return error.retryable
  }
  const code = classifyAgentCoreModelError(error)
  return code === 'rate-limited' || code === 'transient-provider-error' || code === 'network-error'
}
