export type AnthropicContentBlock =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: unknown
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

export type AnthropicResponse = {
  content?: AnthropicContentBlock[]
  error?: {
    message?: string
  }
}

export type AnthropicStreamEvent = {
  type?: string
  index?: number
  content_block?: AnthropicContentBlock
  delta?: {
    type?: string
    text?: string
    partial_json?: string
  }
  error?: {
    message?: string
  }
}

export type AnthropicStreamingToolUse = {
  id: string
  name: string
  partialJson: string
}
