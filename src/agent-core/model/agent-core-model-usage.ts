export type AgentCoreModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cachedInputTokens?: number;
  raw: unknown;
};

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeAnthropicModelUsage(value: unknown): AgentCoreModelUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) {
    return undefined;
  }
  return {
    inputTokens: readNumber(usage, "input_tokens"),
    outputTokens: readNumber(usage, "output_tokens"),
    cacheCreationInputTokens: readNumber(usage, "cache_creation_input_tokens"),
    cacheReadInputTokens: readNumber(usage, "cache_read_input_tokens"),
    raw: value,
  };
}

export function normalizeOpenAIModelUsage(value: unknown): AgentCoreModelUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) {
    return undefined;
  }
  const promptDetails = asRecord(usage.prompt_tokens_details);
  return {
    inputTokens: readNumber(usage, "prompt_tokens"),
    outputTokens: readNumber(usage, "completion_tokens"),
    totalTokens: readNumber(usage, "total_tokens"),
    cachedInputTokens:
      promptDetails === undefined ? undefined : readNumber(promptDetails, "cached_tokens"),
    raw: value,
  };
}
