import type { AgentCoreHttpModelConfig } from "../model/agent-core-http-model-config";
import type { AgentCoreBudgetPolicy } from "./agent-core-budget-types";

export const AGENT_CORE_CONTEXT_WINDOW_DEFAULT_TOKENS = 200_000;
export const AGENT_CORE_CONTEXT_WINDOW_1M_TOKENS = 1_000_000;
export const AGENT_CORE_LOCAL_COMPACT_CONTEXT_WINDOW_TOKENS = 64_000;
export const AGENT_CORE_COMPACT_OUTPUT_RESERVE_MAX_TOKENS = 20_000;
export const AGENT_CORE_AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const AGENT_CORE_DEFAULT_OUTPUT_TOKENS = 32_000;
export const AGENT_CORE_MIN_INPUT_BUDGET_TOKENS = 8_000;

export type AgentCoreBudgetWindowPolicy = Pick<
  AgentCoreBudgetPolicy,
  | "contextWindowTokens"
  | "maxInputTokens"
  | "maxOutputTokens"
  | "compactThresholdTokens"
  | "compactTriggerRatio"
>;

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function modelName(config?: Pick<AgentCoreHttpModelConfig, "model">): string {
  return config?.model.toLowerCase().trim() ?? "";
}

function hasExplicitOneMillionContext(model: string): boolean {
  return /\[1m\]/i.test(model);
}

function isKnownAgentScaleHostedModel(model: string): boolean {
  return (
    model.includes("claude") ||
    model.includes("deepseek") ||
    model.includes("gpt") ||
    model.includes("gemini") ||
    /\bo[134]\b/.test(model)
  );
}

function inferContextWindowTokens(
  config?: Pick<AgentCoreHttpModelConfig, "contextWindowTokens" | "model" | "promptProfile">,
): number {
  const explicit = positiveInteger(config?.contextWindowTokens);
  if (explicit !== undefined) {
    return explicit;
  }

  const model = modelName(config);
  if (hasExplicitOneMillionContext(model)) {
    return AGENT_CORE_CONTEXT_WINDOW_1M_TOKENS;
  }

  // local-compact 是小窗口 profile；Hosted agent 模型仍按 200k 级别预算处理。
  if (config?.promptProfile === "local-compact" && !isKnownAgentScaleHostedModel(model)) {
    return AGENT_CORE_LOCAL_COMPACT_CONTEXT_WINDOW_TOKENS;
  }

  return AGENT_CORE_CONTEXT_WINDOW_DEFAULT_TOKENS;
}

function resolveOutputBudgetTokens(config?: Pick<AgentCoreHttpModelConfig, "maxTokens">): number {
  return positiveInteger(config?.maxTokens) ?? AGENT_CORE_DEFAULT_OUTPUT_TOKENS;
}

function outputReserveTokens(contextWindowTokens: number, outputBudgetTokens: number): number {
  const safeReserveCeiling = Math.max(0, contextWindowTokens - AGENT_CORE_MIN_INPUT_BUDGET_TOKENS);
  return Math.min(
    outputBudgetTokens,
    AGENT_CORE_COMPACT_OUTPUT_RESERVE_MAX_TOKENS,
    safeReserveCeiling,
  );
}

export function createAgentCoreBudgetWindowPolicy(
  config?: Pick<
    AgentCoreHttpModelConfig,
    "contextWindowTokens" | "model" | "promptProfile" | "maxTokens"
  >,
): AgentCoreBudgetWindowPolicy {
  const contextWindowTokens = inferContextWindowTokens(config);
  const outputBudgetTokens = resolveOutputBudgetTokens(config);
  const maxInputTokens = Math.max(
    AGENT_CORE_MIN_INPUT_BUDGET_TOKENS,
    contextWindowTokens - outputReserveTokens(contextWindowTokens, outputBudgetTokens),
  );
  const compactThresholdTokens = Math.max(
    AGENT_CORE_MIN_INPUT_BUDGET_TOKENS,
    maxInputTokens - AGENT_CORE_AUTOCOMPACT_BUFFER_TOKENS,
  );

  return {
    contextWindowTokens,
    maxInputTokens,
    maxOutputTokens: outputBudgetTokens,
    compactThresholdTokens,
    compactTriggerRatio: compactThresholdTokens / maxInputTokens,
  };
}

export function mergeAgentCoreBudgetWindowPolicyOverride<T extends Partial<AgentCoreBudgetPolicy>>(
  basePolicy: T,
  override: Partial<AgentCoreBudgetPolicy> | undefined,
): T & Partial<AgentCoreBudgetPolicy> {
  if (
    override?.compactThresholdTokens === undefined &&
    (override?.maxInputTokens !== undefined || override?.compactTriggerRatio !== undefined)
  ) {
    const { compactThresholdTokens: _compactThresholdTokens, ...baseWithoutThreshold } = basePolicy;
    return {
      ...baseWithoutThreshold,
      ...override,
    } as T & Partial<AgentCoreBudgetPolicy>;
  }
  return {
    ...basePolicy,
    ...override,
  };
}
