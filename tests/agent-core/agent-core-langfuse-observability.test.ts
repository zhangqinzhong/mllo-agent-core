import { describe, expect, it } from "vitest";
import { maskAgentCoreLangfuseSensitiveData } from "../../src/agent-core/observability/agent-core-langfuse-redaction";
import { resolveAgentCoreLangfuseTracing } from "../../src/agent-core/observability/agent-core-langfuse-runtime";
import {
  createAgentCoreLangfuseModelInput,
  createAgentCoreLangfuseUsageDetails,
} from "../../src/agent-core/observability/agent-core-langfuse-summaries";

describe("Langfuse observability helpers", () => {
  it("keeps tracing disabled when Langfuse keys are absent", () => {
    expect(resolveAgentCoreLangfuseTracing({ enabled: false })).toBeUndefined();
  });

  it("captures full model content by default when tracing is configured", () => {
    expect(
      resolveAgentCoreLangfuseTracing({
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
      })?.captureContent,
    ).toBe("full");
  });

  it("maps normalized model usage to Langfuse usageDetails", () => {
    expect(
      createAgentCoreLangfuseUsageDetails({
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
        cachedInputTokens: 2,
        raw: {},
      }),
    ).toEqual({
      input: 12,
      output: 5,
      total: 17,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      cached_input_tokens: 2,
    });
  });

  it("can summarize model input instead of storing full prompt text", () => {
    const input = createAgentCoreLangfuseModelInput({
      captureContent: "summary",
      request: {
        systemPrompt: "secret system prompt",
        messages: [
          {
            role: "user",
            content: "hello",
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "read file content",
            run: async () => ({
              content: "",
            }),
          },
        ],
      },
    });
    expect(input).toEqual({
      systemPromptChars: 20,
      systemPromptBlockCount: 0,
      messageCount: 1,
      messageRoles: ["user"],
      toolCount: 1,
      toolNames: ["read_file"],
    });
  });

  it("redacts common secret shapes before export", () => {
    expect(
      maskAgentCoreLangfuseSensitiveData({
        apiKey: "sk-testsecret1234567890",
        nested: {
          authorization: "Bearer abc.def.ghi",
          text: "token=abc123",
        },
      }),
    ).toEqual({
      apiKey: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        text: "token=[REDACTED]",
      },
    });
  });
});
