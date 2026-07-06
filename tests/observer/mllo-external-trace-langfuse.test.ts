import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  appendMlloExternalTraceRecord,
  createMlloExternalTraceLangfuseGeneration,
  exportMlloExternalTraceLogsToLangfuse,
  type MlloExternalTraceLangfuseGeneration,
  type MlloExternalTraceRecord,
} from "../../src/observer";

function anthropicRecord(
  overrides: Partial<MlloExternalTraceRecord> = {},
): MlloExternalTraceRecord {
  return {
    type: "external_trace",
    schemaVersion: 1,
    id: "trace-1",
    source: "claude-code",
    protocol: "anthropic",
    startedAt: "2026-07-05T00:00:00.000Z",
    completedAt: "2026-07-05T00:00:01.000Z",
    durationMs: 1000,
    upstreamUrl: "https://api.deepseek.example/v1/messages",
    request: {
      method: "POST",
      pathname: "/v1/messages",
      model: "deepseek-v4-pro",
      stream: true,
      messageCount: 2,
      systemBlockCount: 1,
      toolCount: 1,
      toolNames: ["read_file"],
      bodyBytes: 123,
      body: {
        model: "deepseek-v4-pro",
        messages: [
          {
            role: "user",
            content: "hello",
          },
        ],
      },
    },
    response: {
      statusCode: 200,
      contentType: "application/json",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 3,
      },
      stopReason: "end_turn",
      bodyBytes: 456,
      body: {
        content: [
          {
            type: "text",
            text: "hi",
          },
        ],
      },
    },
    ...overrides,
  };
}

describe("external trace Langfuse export", () => {
  it("converts a Claude Code Anthropic trace into a distinguishable Langfuse generation", () => {
    const generation = createMlloExternalTraceLangfuseGeneration(anthropicRecord());

    expect(generation.traceName).toBe("external.claude-code.run");
    expect(generation.name).toBe("anthropic./v1/messages");
    expect(generation.model).toBe("deepseek-v4-pro");
    expect(generation.tags).toEqual(["external-agent", "claude-code", "anthropic-compatible"]);
    expect(generation.metadata).toMatchObject({
      source: "claude-code",
      protocol: "anthropic",
      upstreamHost: "api.deepseek.example",
      proxy: "mllo-trace-proxy",
    });
    expect(generation.usageDetails).toEqual({
      input: 10,
      output: 4,
      cache_read_input_tokens: 3,
    });
    expect(generation.input).toMatchObject({
      model: "deepseek-v4-pro",
    });
    expect(generation.output).toMatchObject({
      content: [
        {
          text: "hi",
        },
      ],
    });
  });

  it("exports JSONL records once and skips already exported ids", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "mllo-external-langfuse-"));
    const exported: MlloExternalTraceLangfuseGeneration[] = [];
    await appendMlloExternalTraceRecord(anthropicRecord(), {
      homePath,
    });

    const first = await exportMlloExternalTraceLogsToLangfuse({
      homePath,
      source: "claude-code",
      writer: async (generation) => {
        exported.push(generation);
      },
    });
    const second = await exportMlloExternalTraceLogsToLangfuse({
      homePath,
      source: "claude-code",
      writer: async (generation) => {
        exported.push(generation);
      },
    });

    expect(first).toMatchObject({
      scanned: 1,
      exported: 1,
      skipped: 0,
      failed: 0,
      disabled: false,
    });
    expect(second).toMatchObject({
      scanned: 1,
      exported: 0,
      skipped: 1,
      failed: 0,
      disabled: false,
    });
    expect(exported.map((item) => item.recordId)).toEqual(["trace-1"]);
  });
});
