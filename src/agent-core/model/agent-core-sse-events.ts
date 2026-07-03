// 解析 SSE 数据流。HTTP adapter 用它把 provider wire event 转成 Agent Core stream event。
export async function* readAgentCoreSseData(
  body: ReadableStream<Uint8Array> | null
): AsyncGenerator<string> {
  if (body === null) {
    throw new Error('SSE response body is empty.')
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    buffer += decoder.decode(chunk.value, {
      stream: true
    })

    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const data of parseSseEventData(rawEvent)) {
        yield data
      }
      boundary = buffer.indexOf('\n\n')
    }
  }

  buffer += decoder.decode()
  if (buffer.trim().length > 0) {
    for (const data of parseSseEventData(buffer)) {
      yield data
    }
  }
}

// 提取一个 SSE event 里的 data 行。多行 data 要按 SSE 规范用换行合并。
function parseSseEventData(rawEvent: string): string[] {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
  if (dataLines.length === 0) {
    return []
  }
  return [dataLines.join('\n')]
}
