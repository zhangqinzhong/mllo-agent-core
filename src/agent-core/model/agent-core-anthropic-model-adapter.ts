import type {
  AgentCoreMessage,
  AgentCoreModelAdapter,
  AgentCoreModelRequest,
  AgentCoreModelResponse,
  AgentCoreModelStreamEvent,
} from "../query-loop/agent-core-query-types";
import type { AgentCorePromptBlock } from "../query-loop/agent-core-prompt-block-types";
import type { AgentCoreHttpModelConfig } from "./agent-core-http-model-config";
import {
  fetchAgentCoreModelResponse,
  type AgentCoreModelFetch,
} from "./agent-core-model-fetch-response";
import {
  createAgentCoreToolCall,
  normalizeAgentCoreMessagesForWire,
  stringifyAgentCoreToolCallInput,
  toAgentCoreWireToolSchema,
} from "./agent-core-model-wire";
import {
  createAgentCoreModelHttpError,
  createAgentCoreModelProviderError,
} from "./agent-core-model-error-classification";
import { normalizeAnthropicModelUsage, type AgentCoreModelUsage } from "./agent-core-model-usage";
import { readAgentCoreSseData } from "./agent-core-sse-events";
import { parseAgentCoreStreamJsonEvent } from "./agent-core-stream-json-event";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicResponse,
  AnthropicStreamingToolUse,
  AnthropicStreamEvent,
} from "./agent-core-anthropic-wire-types";
import {
  captureAnthropicContentBlockStart,
  flushAnthropicToolCallAtIndex,
  flushAnthropicToolCalls,
  handleAnthropicDelta,
} from "./agent-core-anthropic-streaming-blocks";

type AnthropicSystemTextBlock = {
  type: "text";
  text: string;
  cache_control?: {
    type: "ephemeral";
  };
};

type AnthropicToolDefinition = {
  name: string;
  description: string;
  input_schema: unknown;
  cache_control?: {
    type: "ephemeral";
  };
};

// 读取 Anthropic 错误响应。stream 建立失败时错误信息不在 SSE 事件里。
async function readAnthropicErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as AnthropicResponse;
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

// Anthropic 协议要求 system 顶层传入，messages 只允许 user/assistant 交替。
function toAnthropicMessages(messages: readonly AgentCoreMessage[]): AnthropicMessage[] {
  const output: AnthropicMessage[] = [];
  for (const message of normalizeAgentCoreMessagesForWire(messages)) {
    if (message.role === "user") {
      appendAnthropicBlocks(output, "user", [
        {
          type: "text",
          text: message.content,
        },
      ]);
      continue;
    }
    if (message.role === "tool") {
      appendAnthropicBlocks(output, "user", [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content.length > 0 ? message.content : "(no output)",
          is_error: message.isError,
        },
      ]);
      continue;
    }
    appendAnthropicBlocks(output, "assistant", [
      ...(message.content.length > 0
        ? [
            {
              type: "text" as const,
              text: message.content,
            },
          ]
        : []),
      ...(message.toolCalls?.map((call) => ({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: JSON.parse(stringifyAgentCoreToolCallInput(call)) as unknown,
      })) ?? []),
    ]);
  }
  return output;
}

// 合并连续同 role 消息。Anthropic Messages API 对交替 turn 更严格。
function appendAnthropicBlocks(
  messages: AnthropicMessage[],
  role: AnthropicMessage["role"],
  blocks: AnthropicContentBlock[],
): void {
  if (blocks.length === 0) {
    return;
  }
  const previous = messages.at(-1);
  if (previous?.role === role) {
    previous.content.push(...blocks);
    return;
  }
  messages.push({
    role,
    content: blocks,
  });
}

function addAnthropicCacheControlToLastBlock(messages: AnthropicMessage[]): void {
  const lastMessage = messages.at(-1);
  const lastBlock = lastMessage?.content.at(-1);
  if (lastBlock === undefined) {
    return;
  }
  lastBlock.cache_control = {
    type: "ephemeral",
  };
}

// Anthropic base_url 存根路径，实际 API 固定是 /v1/messages。
function anthropicMessagesUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
  return `${root}/v1/messages`;
}

function lastPromptBlockIndexByScope(
  blocks: readonly AgentCorePromptBlock[],
  scope: AgentCorePromptBlock["cacheScope"],
): number | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.cacheScope === scope && block.text.length > 0) {
      return index;
    }
  }
  return undefined;
}

function createAnthropicCacheBreakpointIndexes(
  blocks: readonly AgentCorePromptBlock[],
): Set<number> {
  const indexes = new Set<number>();
  const globalIndex = lastPromptBlockIndexByScope(blocks, "global");
  const sessionIndex = lastPromptBlockIndexByScope(blocks, "session");
  if (globalIndex !== undefined) {
    indexes.add(globalIndex);
  }
  if (sessionIndex !== undefined) {
    indexes.add(sessionIndex);
  }
  return indexes;
}

function toAnthropicSystem(
  request: AgentCoreModelRequest,
): string | AnthropicSystemTextBlock[] | undefined {
  const blocks = request.systemPromptBlocks?.filter((block) => block.text.length > 0);
  if (blocks === undefined) {
    return request.systemPrompt;
  }
  if (blocks.length === 0) {
    return undefined;
  }
  const cacheBreakpointIndexes = createAnthropicCacheBreakpointIndexes(blocks);
  return blocks.map((block, index) => ({
    type: "text" as const,
    text: block.text,
    ...(cacheBreakpointIndexes.has(index)
      ? {
          cache_control: {
            type: "ephemeral" as const,
          },
        }
      : {}),
  }));
}

function toAnthropicTools(request: AgentCoreModelRequest): AnthropicToolDefinition[] {
  const tools: AnthropicToolDefinition[] = request.tools.map((tool) => {
    const schema = toAgentCoreWireToolSchema(tool);
    return {
      name: schema.name,
      description: schema.description,
      input_schema: schema.parameters,
    };
  });
  const lastTool = tools.at(-1);
  if (lastTool !== undefined) {
    lastTool.cache_control = {
      type: "ephemeral",
    };
  }
  return tools;
}

function toAnthropicRequestMessages(request: AgentCoreModelRequest): AnthropicMessage[] {
  const messages = toAnthropicMessages(request.messages);
  addAnthropicCacheControlToLastBlock(messages);
  return messages;
}

// 构建 Anthropic 请求体。stream/complete 共用，避免字段不一致。
function createAnthropicRequestBody(
  request: AgentCoreModelRequest,
  config: AgentCoreHttpModelConfig,
  stream: boolean,
): string {
  return JSON.stringify({
    model: config.model,
    max_tokens: config.maxTokens ?? 32_768,
    system: toAnthropicSystem(request),
    messages: toAnthropicRequestMessages(request),
    tools: toAnthropicTools(request),
    stream,
  });
}

// 第三方 Anthropic-compatible 端点可能沿用 Claude Code 的 Bearer token 约定。
function createAnthropicRequestHeaders(config: AgentCoreHttpModelConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "anthropic-version": config.anthropicVersion ?? "2023-06-01",
    "Content-Type": "application/json",
  };
  if (config.anthropicAuthHeader === "authorization") {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  } else {
    headers["x-api-key"] = config.apiKey;
  }
  return headers;
}

// 创建 Anthropic Messages API adapter。Anthropic-compatible 端点都走这里。
export function createAgentCoreAnthropicModelAdapter(
  config: AgentCoreHttpModelConfig,
  fetchImpl: AgentCoreModelFetch = fetch,
): AgentCoreModelAdapter {
  return {
    async complete(request: AgentCoreModelRequest): Promise<AgentCoreModelResponse> {
      const response = await fetchAgentCoreModelResponse({
        fetchImpl,
        url: anthropicMessagesUrl(config.baseUrl),
        init: {
          method: "POST",
          headers: createAnthropicRequestHeaders(config),
          body: createAnthropicRequestBody(request, config, false),
          signal: request.signal,
        },
      });
      if (!response.ok) {
        throw createAgentCoreModelHttpError({
          message: await readAnthropicErrorMessage(
            response,
            `Anthropic request failed: ${response.status}`,
          ),
          status: response.status,
        });
      }
      const body = (await response.json()) as AnthropicResponse;
      const blocks = body.content ?? [];
      return {
        content: blocks
          .filter((block): block is Extract<AnthropicContentBlock, { type: "text" }> => {
            return block.type === "text";
          })
          .map((block) => block.text)
          .join(""),
        toolCalls: blocks
          .filter((block): block is Extract<AnthropicContentBlock, { type: "tool_use" }> => {
            return block.type === "tool_use";
          })
          .map((block, index) =>
            createAgentCoreToolCall({
              id: block.id,
              index,
              name: block.name,
              arguments: block.input,
            }),
          ),
        usage: normalizeAnthropicModelUsage(body.usage),
      };
    },
    async *stream(request: AgentCoreModelRequest): AsyncIterable<AgentCoreModelStreamEvent> {
      const response = await fetchAgentCoreModelResponse({
        fetchImpl,
        url: anthropicMessagesUrl(config.baseUrl),
        init: {
          method: "POST",
          headers: createAnthropicRequestHeaders(config),
          body: createAnthropicRequestBody(request, config, true),
          signal: request.signal,
        },
      });
      if (!response.ok) {
        throw createAgentCoreModelHttpError({
          message: await readAnthropicErrorMessage(
            response,
            `Anthropic stream request failed: ${response.status}`,
          ),
          status: response.status,
        });
      }

      const toolCalls = new Map<number, AnthropicStreamingToolUse>();
      let streamDone = false;
      let usage: AgentCoreModelUsage | undefined;
      for await (const data of readAgentCoreSseData(response.body)) {
        const event = parseAgentCoreStreamJsonEvent<AnthropicStreamEvent>({
          protocol: "anthropic",
          data,
        });
        if (event.error?.message !== undefined) {
          throw new Error(event.error.message);
        }
        if (event.type === "content_block_start") {
          captureAnthropicContentBlockStart(toolCalls, event);
          continue;
        }
        if (event.message?.usage !== undefined) {
          usage = normalizeAnthropicModelUsage(event.message.usage);
          continue;
        }
        if (event.usage !== undefined) {
          usage = normalizeAnthropicModelUsage(event.usage);
          continue;
        }
        if (event.type === "content_block_delta") {
          yield* handleAnthropicDelta(toolCalls, event);
          continue;
        }
        if (event.type === "content_block_stop") {
          yield* flushAnthropicToolCallAtIndex(toolCalls, event.index);
          continue;
        }
        if (event.type === "message_stop") {
          streamDone = true;
          break;
        }
      }
      if (!streamDone) {
        yield* flushAnthropicToolCalls(toolCalls);
        throw createAgentCoreModelProviderError({
          message: "anthropic stream ended before message_stop.",
          retryable: true,
        });
      }

      yield* flushAnthropicToolCalls(toolCalls);
      yield {
        type: "message-end",
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}
