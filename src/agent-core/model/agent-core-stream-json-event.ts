import { createAgentCoreModelProviderError } from './agent-core-model-error-classification'

const MAX_STREAM_JSON_PREVIEW_CHARS = 160

function previewStreamJsonPayload(data: string): string {
  const singleLine = data.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= MAX_STREAM_JSON_PREVIEW_CHARS) {
    return singleLine
  }
  return `${singleLine.slice(0, MAX_STREAM_JSON_PREVIEW_CHARS)}...`
}

// Provider SSE 偶尔会吐坏 JSON。包装成模型错误，方便 query loop 记录协议和 payload 预览。
export function parseAgentCoreStreamJsonEvent<T>(args: {
  protocol: 'anthropic' | 'openai'
  data: string
}): T {
  try {
    return JSON.parse(args.data) as T
  } catch (error) {
    throw createAgentCoreModelProviderError({
      message: `${args.protocol} stream emitted invalid JSON event: ${previewStreamJsonPayload(args.data)}`,
      cause: error
    })
  }
}
