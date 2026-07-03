import { describe, expect, it } from "vitest";
import { runAgentCoreQueryLoop } from "../../src/agent-core/query-loop/agent-core-query-loop";
import type {
  AgentCoreQueryEvent,
  AgentCoreQueryLoopResult,
} from "../../src/agent-core/query-loop/agent-core-query-types";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";

async function drainQueryLoop(args: {
  tools: readonly AgentCoreToolDefinition[];
  toolInputs: readonly Record<string, unknown>[];
}): Promise<{
  events: AgentCoreQueryEvent[];
  result: AgentCoreQueryLoopResult;
}> {
  let streamCount = 0;
  const events: AgentCoreQueryEvent[] = [];
  const loop = runAgentCoreQueryLoop({
    cwd: "/tmp/project",
    messages: [
      {
        role: "user",
        content: "run tools",
      },
    ],
    tools: args.tools,
    model: {
      stream: async function* () {
        streamCount += 1;
        if (streamCount === 1) {
          for (const [index, input] of args.toolInputs.entries()) {
            yield {
              type: "tool-call",
              call: {
                id: `call_${index}`,
                name: args.tools[index]!.name,
                input,
              },
            };
          }
          yield {
            type: "message-end",
          };
          return;
        }
        yield {
          type: "text-delta",
          content: "done",
        };
        yield {
          type: "message-end",
        };
      },
    },
    maxTurns: 3,
    storeToolResultBlob: async ({ content, originalChars, call }) => ({
      outputBlobPath: `blob/${call.id}.json`,
      outputBlobBytes: Buffer.byteLength(content, "utf8"),
      originalChars,
    }),
  });

  while (true) {
    const item = await loop.next();
    if (item.done === true) {
      return {
        events,
        result: item.value,
      };
    }
    events.push(item.value);
  }
}

describe("agent core tool batch summary", () => {
  it("emits a deterministic summary after a completed tool batch", async () => {
    const tools: AgentCoreToolDefinition[] = [
      {
        name: "read_file",
        description: "Read file.",
        run: async () => ({
          content: "file contents",
        }),
      },
      {
        name: "run_tests",
        description: "Run tests.",
        run: async () => ({
          content: "test failed",
          isError: true,
          errorKind: "tool-error",
        }),
      },
    ];

    const { events, result } = await drainQueryLoop({
      tools,
      toolInputs: [
        {
          path: "README.md",
        },
        {
          command: "npm test",
        },
      ],
    });

    const summary = events.find((event) => event.type === "tool-batch-summary");
    expect(result.status).toBe("completed");
    expect(summary).toMatchObject({
      type: "tool-batch-summary",
      turn: 1,
      summary: {
        label: "Ran 2 tools: read_file, run_tests (1 failed)",
        toolCallIds: ["call_0", "call_1"],
        okCount: 1,
        errorCount: 1,
        truncatedCount: 0,
        items: [
          {
            toolCallId: "call_0",
            toolName: "read_file",
            status: "ok",
          },
          {
            toolCallId: "call_1",
            toolName: "run_tests",
            status: "error",
            errorKind: "tool-error",
          },
        ],
      },
    });
  });

  it("does not copy raw tool input or output into the batch summary", async () => {
    const secret = "sk-live-secret-value";
    const tools: AgentCoreToolDefinition[] = [
      {
        name: "secret_tool",
        description: "Return secret output.",
        maxResultSizeChars: 8,
        run: async () => ({
          content: `output contains ${secret}`,
        }),
      },
    ];

    const { events } = await drainQueryLoop({
      tools,
      toolInputs: [
        {
          token: secret,
        },
      ],
    });

    const summary = events.find((event) => event.type === "tool-batch-summary");
    expect(summary?.type).toBe("tool-batch-summary");
    if (summary?.type !== "tool-batch-summary") {
      throw new Error("expected tool-batch-summary event");
    }
    const serialized = JSON.stringify(summary.summary);
    expect(summary.summary).toMatchObject({
      label: "secret_tool completed with truncated output",
      okCount: 1,
      truncatedCount: 1,
      items: [
        {
          toolCallId: "call_0",
          toolName: "secret_tool",
          status: "ok",
          outputTruncated: true,
          outputBlobPath: "blob/call_0.json",
        },
      ],
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("output contains");
  });
});
