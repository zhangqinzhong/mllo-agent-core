import { describe, expect, it } from "vitest";
import {
  createAgentCoreBudgetWindowPolicy,
  mergeAgentCoreBudgetWindowPolicyOverride,
} from "../../src/agent-core/budget/agent-core-model-budget-policy";

describe("agent core model budget policy", () => {
  it("uses a 200k default window for hosted agent-scale models", () => {
    const policy = createAgentCoreBudgetWindowPolicy({
      protocol: "anthropic",
      baseUrl: "https://example.com",
      apiKey: "key",
      model: "deepseek-v4-pro",
      maxTokens: 32_768,
      promptProfile: "local-compact",
    });

    expect(policy.contextWindowTokens).toBe(200_000);
    expect(policy.maxInputTokens).toBe(180_000);
    expect(policy.compactThresholdTokens).toBe(167_000);
    expect(policy.maxOutputTokens).toBe(32_768);
  });

  it("honors explicit contextWindowTokens from provider config", () => {
    const policy = createAgentCoreBudgetWindowPolicy({
      protocol: "openai",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "local-key",
      model: "local-model",
      contextWindowTokens: 131_072,
      maxTokens: 8_192,
    });

    expect(policy.contextWindowTokens).toBe(131_072);
    expect(policy.maxInputTokens).toBe(122_880);
    expect(policy.compactThresholdTokens).toBe(109_880);
  });

  it("recognizes explicit 1m model suffix", () => {
    const policy = createAgentCoreBudgetWindowPolicy({
      protocol: "anthropic",
      baseUrl: "https://example.com",
      apiKey: "key",
      model: "claude-sonnet-4[1m]",
    });

    expect(policy.contextWindowTokens).toBe(1_000_000);
    expect(policy.maxInputTokens).toBe(980_000);
    expect(policy.compactThresholdTokens).toBe(967_000);
  });

  it("keeps local-compact fallback small for unknown local models", () => {
    const policy = createAgentCoreBudgetWindowPolicy({
      protocol: "openai",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "local-key",
      model: "local-model",
      promptProfile: "local-compact",
    });

    expect(policy.contextWindowTokens).toBe(64_000);
    expect(policy.maxInputTokens).toBe(44_000);
    expect(policy.compactThresholdTokens).toBe(31_000);
  });

  it("drops derived compact threshold when callers override max input budget", () => {
    const merged = mergeAgentCoreBudgetWindowPolicyOverride(createAgentCoreBudgetWindowPolicy(), {
      maxInputTokens: 1,
      compactTriggerRatio: 0,
    });

    expect(merged.compactThresholdTokens).toBeUndefined();
    expect(merged.maxInputTokens).toBe(1);
    expect(merged.compactTriggerRatio).toBe(0);
  });
});
