import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getMlloDumpPromptsPath } from '../runtime-home/mllo-home-paths'
import type { MlloRuntimeHomeOptions } from '../runtime-home/mllo-runtime-home-types'

type MlloDumpPromptState = {
  initialized: boolean
  messageCountSeen: number
  lastInitDataHash: string
  lastInitFingerprint: string
}

type MlloDumpPromptFetchOptions = MlloRuntimeHomeOptions & {
  sessionId: string
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const dumpPromptStateBySession = new Map<string, MlloDumpPromptState>()
const pendingDumpPromptWrites = new Set<Promise<void>>()
const dumpPromptWriteQueueByFile = new Map<string, Promise<void>>()

// 判断 prompt dump 是否开启；默认关闭，避免把敏感 prompt 长期落盘。
export function isMlloDumpPromptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MLLO_DUMP_PROMPTS === '1' || env.MLLO_DUMP_PROMPTS === 'true'
}

// 清空 dump 状态，测试或 session 硬重置时用，避免 messageCount 继承到下一轮。
export function clearMlloDumpPromptsState(sessionId?: string): void {
  if (sessionId === undefined) {
    dumpPromptStateBySession.clear()
    return
  }
  dumpPromptStateBySession.delete(sessionId)
}

// 等待异步 dump 写入完成，避免测试读取文件时还没落盘。
export async function flushMlloDumpPromptWrites(): Promise<void> {
  await Promise.allSettled(pendingDumpPromptWrites)
}

// 创建带 prompt dump 的 fetch；关闭时直接返回原 fetch，不改变模型请求路径。
export function createMlloDumpPromptsFetch(options: MlloDumpPromptFetchOptions): typeof fetch {
  const baseFetch = options.fetchImpl ?? fetch
  const env = options.env ?? process.env
  if (!isMlloDumpPromptsEnabled(env)) {
    return baseFetch
  }

  const filePath = getMlloDumpPromptsPath(options.sessionId, options)
  const wrappedFetch: typeof fetch = async (input, init) => {
    const state = getDumpPromptState(options.sessionId)
    const timestamp = new Date().toISOString()
    const requestBody = getRequestBodyText(input, init)
    const shouldDumpRequest = isPostRequest(input, init) && requestBody !== undefined
    if (shouldDumpRequest) {
      scheduleDumpPromptWrite(filePath, () =>
        dumpPromptRequest(requestBody, timestamp, state, filePath)
      )
    }

    const response = await baseFetch(input, init)
    if (shouldDumpRequest && response.ok) {
      scheduleDumpPromptWrite(filePath, () => dumpPromptResponse(response, timestamp, filePath))
    }
    return response
  }
  return wrappedFetch
}

// 获取当前 session 的去重状态；同一会话多轮请求不能重复写 system/tools。
function getDumpPromptState(sessionId: string): MlloDumpPromptState {
  const state = dumpPromptStateBySession.get(sessionId)
  if (state !== undefined) {
    return state
  }
  const nextState: MlloDumpPromptState = {
    initialized: false,
    messageCountSeen: 0,
    lastInitDataHash: '',
    lastInitFingerprint: ''
  }
  dumpPromptStateBySession.set(sessionId, nextState)
  return nextState
}

// 判断是否是模型 POST；非 POST 请求不代表一轮模型输入，不写 dump。
function isPostRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : undefined)
  return method?.toUpperCase() === 'POST'
}

// 读取 fetch body 文本；只处理当前 adapter 使用的可复读 body，避免消费 stream。
function getRequestBodyText(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  if (typeof init?.body === 'string') {
    return init.body
  }
  if (Buffer.isBuffer(init?.body)) {
    return init.body.toString('utf8')
  }
  if (input instanceof Request && typeof init?.body !== 'string') {
    return undefined
  }
  return undefined
}

// 异步写 dump，保证调试日志不拖慢真实模型请求。
function scheduleDumpPromptWrite(filePath: string, operation: () => Promise<void>): void {
  const previousWrite = dumpPromptWriteQueueByFile.get(filePath) ?? Promise.resolve()
  const write = previousWrite
    .catch(() => {
      // 前一条调试日志失败不能阻断后续 dump，真实模型请求已经返回。
    })
    .then(() => {
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          void operation().then(resolve, resolve)
        })
      })
    })
  dumpPromptWriteQueueByFile.set(filePath, write)
  pendingDumpPromptWrites.add(write)
  void write.finally(() => {
    pendingDumpPromptWrites.delete(write)
    if (dumpPromptWriteQueueByFile.get(filePath) === write) {
      dumpPromptWriteQueueByFile.delete(filePath)
    }
  })
}

// 按调试边界拆 request：init/system_update 放系统态，message 只放新增用户输入。
async function dumpPromptRequest(
  body: string,
  timestamp: string,
  state: MlloDumpPromptState,
  filePath: string
): Promise<void> {
  const request = parseJsonRecord(body)
  if (request === undefined) {
    return
  }

  const entries: unknown[] = []
  const messages = Array.isArray(request.messages) ? request.messages : []
  const initData = createDumpPromptInitData(request, messages)
  const fingerprint = createDumpPromptInitFingerprint(initData)
  if (!state.initialized || fingerprint !== state.lastInitFingerprint) {
    const initDataJson = JSON.stringify(initData)
    const initDataHash = hashString(initDataJson)
    state.lastInitFingerprint = fingerprint
    if (!state.initialized) {
      state.initialized = true
      state.lastInitDataHash = initDataHash
      entries.push({
        type: 'init',
        timestamp,
        data: initData
      })
    } else if (initDataHash !== state.lastInitDataHash) {
      state.lastInitDataHash = initDataHash
      entries.push({
        type: 'system_update',
        timestamp,
        data: initData
      })
    }
  }

  for (const message of messages.slice(state.messageCountSeen)) {
    if (isDumpPromptInputMessage(message)) {
      entries.push({
        type: 'message',
        timestamp,
        data: message
      })
    }
  }
  state.messageCountSeen = messages.length
  await appendDumpPromptEntries(filePath, entries)
}

// 写 response dump；SSE 先解析成 chunk 数组，便于后续复盘流式输出。
async function dumpPromptResponse(
  response: Response,
  timestamp: string,
  filePath: string
): Promise<void> {
  const clone = response.clone()
  const data = await readDumpPromptResponseData(clone)
  await appendDumpPromptEntries(filePath, [
    {
      type: 'response',
      timestamp,
      data
    }
  ])
}

// 解析 response 数据；普通 JSON 和 SSE 分开，避免把 raw stream 直接塞进 transcript。
async function readDumpPromptResponseData(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.includes('text/event-stream') === true) {
    const text = await response.text()
    return {
      stream: true,
      chunks: parseDumpPromptSseChunks(text)
    }
  }
  return await response.json()
}

// 从 SSE 文本里提取 data JSON；坏 chunk 只影响调试日志，不影响真实请求。
function parseDumpPromptSseChunks(text: string): unknown[] {
  const chunks: unknown[] = []
  for (const event of text.split('\n\n')) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') {
        continue
      }
      const chunk = parseJson(line.slice(6))
      if (chunk !== undefined) {
        chunks.push(chunk)
      }
    }
  }
  return chunks
}

// 构造 init 数据；OpenAI 的 system 在 messages 里，需要提升出来才能对齐 Anthropic 语义。
function createDumpPromptInitData(
  request: Record<string, unknown>,
  messages: readonly unknown[]
): Record<string, unknown> {
  const { messages: _messages, ...initData } = request
  const systemMessages = messages.filter(isDumpPromptSystemMessage)
  if (systemMessages.length === 0) {
    return initData
  }
  return {
    ...initData,
    system_messages: systemMessages
  }
}

// 粗粒度指纹先挡住绝大多数重复 system/tools，减少大对象 stringify 成本。
function createDumpPromptInitFingerprint(initData: Record<string, unknown>): string {
  return [
    String(initData.model ?? ''),
    getDumpPromptSystemLength(initData),
    getDumpPromptToolNames(initData.tools).join(',')
  ].join('|')
}

// 计算 system 文本规模；这里不用内容本身，避免每轮都比较大字符串。
function getDumpPromptSystemLength(initData: Record<string, unknown>): number {
  return getTextLikeLength(initData.system) + getTextLikeLength(initData.system_messages)
}

// 提取工具名；Anthropic 和 OpenAI-compatible 的 tool schema 位置不一样。
function getDumpPromptToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return []
  }
  return tools.map((tool) => {
    if (isRecord(tool) && typeof tool.name === 'string') {
      return tool.name
    }
    if (isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === 'string') {
      return tool.function.name
    }
    return ''
  })
}

// 判断是否要写入 message entry；OpenAI 的 tool_result 是 role=tool，语义上等同模型输入侧 tool_result。
function isDumpPromptInputMessage(message: unknown): boolean {
  if (!isRecord(message)) {
    return false
  }
  return message.role === 'user' || message.role === 'tool'
}

// 判断 OpenAI system message；Anthropic system 已经在顶层，不会走这里。
function isDumpPromptSystemMessage(message: unknown): boolean {
  return isRecord(message) && message.role === 'system'
}

// 递归估算文本长度；只用于 cheap fingerprint，不要求严格 token 精度。
function getTextLikeLength(value: unknown): number {
  if (typeof value === 'string') {
    return value.length
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + getTextLikeLength(item), 0)
  }
  if (!isRecord(value)) {
    return 0
  }
  return Object.values(value).reduce<number>((total, item) => total + getTextLikeLength(item), 0)
}

// 追加 JSONL entry；目录按需创建，dump 关闭时不会产生空目录。
async function appendDumpPromptEntries(
  filePath: string,
  entries: readonly unknown[]
): Promise<void> {
  if (entries.length === 0) {
    return
  }
  await mkdir(dirname(filePath), {
    recursive: true
  })
  await appendFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
}

// 对初始化数据做 hash，只有真实内容变化时才写 system_update。
function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// 安全解析对象 JSON；坏请求体不应该影响模型调用。
function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  const parsed = parseJson(value)
  return isRecord(parsed) ? parsed : undefined
}

// 安全解析任意 JSON；dump 是调试能力，解析失败直接丢弃该片段。
function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

// 判断普通对象；避免把数组或 null 当作可枚举配置对象处理。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
