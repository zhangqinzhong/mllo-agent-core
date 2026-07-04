export type AnthropicContentBlock =
  | {
      type: "text";
      text: string;
      cache_control?: AnthropicCacheControl;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      cache_control?: AnthropicCacheControl;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      cache_control?: AnthropicCacheControl;
    };

export type AnthropicCacheControl = {
  type: "ephemeral";
};

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

export type AnthropicResponse = {
  content?: AnthropicContentBlock[];
  usage?: AnthropicUsage;
  error?: {
    message?: string;
  };
};

export type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  message?: {
    usage?: AnthropicUsage;
  };
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
  usage?: AnthropicUsage;
  error?: {
    message?: string;
  };
};

export type AnthropicStreamingToolUse = {
  id: string;
  name: string;
  partialJson: string;
};
