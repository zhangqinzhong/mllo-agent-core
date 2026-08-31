import type { AgentCoreHttpModelConfig } from "../model/agent-core-http-model-config";
import type { AgentCoreModelUsage } from "../model/agent-core-model-usage";
import type {
  AgentCoreModelRequest,
  AgentCoreModelResponse,
} from "../query-loop/agent-core-query-types";
import type { AgentCoreRunControllerResult } from "../runtime/agent-core-run-controller-types";
import type { AgentCoreLangfuseCaptureContent } from "./agent-core-langfuse-options";

export function createAgentCoreLangfuseUsageDetails(
  usage?: AgentCoreModelUsage,
): Record<string, number> | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const details: Record<string, number> = {};
  if (usage.inputTokens !== undefined) {
    details.input = usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    details.output = usage.outputTokens;
  }
  if (usage.totalTokens !== undefined) {
    details.total = usage.totalTokens;
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    details.cache_creation_input_tokens = usage.cacheCreationInputTokens;
  }
  if (usage.cacheReadInputTokens !== undefined) {
    details.cache_read_input_tokens = usage.cacheReadInputTokens;
  }
  if (usage.cachedInputTokens !== undefined) {
    details.cached_input_tokens = usage.cachedInputTokens;
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

function summarizeToolNames(request: AgentCoreModelRequest): string[] {
  return request.tools.map((tool) => tool.name);
}

function summarizeMessageRoles(request: AgentCoreModelRequest): string[] {
  return request.messages.map((message) => message.role);
}

export function createAgentCoreLangfuseModelInput(args: {
  request: AgentCoreModelRequest;
  captureContent: AgentCoreLangfuseCaptureContent;
}): unknown {
  if (args.captureContent === "none") {
    return undefined;
  }
  if (args.captureContent === "full") {
    return {
      systemPrompt: args.request.systemPrompt,
      systemPromptBlocks: args.request.systemPromptBlocks,
      messages: args.request.messages,
      tools: args.request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        hasInputSchema: tool.inputSchema !== undefined,
      })),
    };
  }
  return {
    systemPromptChars: args.request.systemPrompt?.length ?? 0,
    systemPromptBlockCount: args.request.systemPromptBlocks?.length ?? 0,
    messageCount: args.request.messages.length,
    messageRoles: summarizeMessageRoles(args.request),
    toolCount: args.request.tools.length,
    toolNames: summarizeToolNames(args.request),
  };
}

export function createAgentCoreLangfuseModelOutput(args: {
  response: AgentCoreModelResponse;
  captureContent: AgentCoreLangfuseCaptureContent;
}): unknown {
  if (args.captureContent === "none") {
    return undefined;
  }
  if (args.captureContent === "full") {
    return {
      content: args.response.content,
      toolCalls: args.response.toolCalls,
    };
  }
  return {
    contentChars: args.response.content.length,
    toolCallCount: args.response.toolCalls?.length ?? 0,
    toolNames: args.response.toolCalls?.map((call) => call.name) ?? [],
  };
}

export function createAgentCoreLangfuseProviderMetadata(
  provider: AgentCoreHttpModelConfig,
): Record<string, string> {
  let baseUrlHost = provider.baseUrl.slice(0, 200);
  try {
    baseUrlHost = new URL(provider.baseUrl).host;
  } catch {
    // baseUrl 校验属于模型 adapter；观测层只做降级展示。
  }
  return {
    provider: provider.name ?? provider.protocol,
    protocol: provider.protocol,
    model: provider.model,
    baseUrlHost,
  };
}

export function createAgentCoreLangfuseModelParameters(
  provider: AgentCoreHttpModelConfig,
): Record<string, string | number> {
  return {
    protocol: provider.protocol,
    ...(provider.maxTokens === undefined ? {} : { maxTokens: provider.maxTokens }),
    ...(provider.temperature === undefined ? {} : { temperature: provider.temperature }),
  };
}

export function createAgentCoreLangfuseRunInput(args: {
  input: string;
  cwd: string;
  workspaceRoots: readonly string[];
  captureContent: AgentCoreLangfuseCaptureContent;
}): unknown {
  if (args.captureContent === "none") {
    return undefined;
  }
  return {
    cwd: args.cwd,
    workspaceRootCount: args.workspaceRoots.length,
    input: args.captureContent === "full" ? args.input : `[${args.input.length} chars]`,
  };
}

export function createAgentCoreLangfuseRunOutput(
  result: AgentCoreRunControllerResult,
): Record<string, unknown> {
  return {
    status: result.status,
    messageCount: result.messages.length,
    terminal: result.terminal,
  };
}
