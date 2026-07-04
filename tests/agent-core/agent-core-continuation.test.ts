import { describe, expect, it } from "vitest";
import {
  collectQueryLoop,
  loopArgs,
  scriptedModel,
} from "../../src/agent-core/query-loop/agent-core-query-loop-test-support";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";

describe("agent core continuation events", () => {
  it("records next_turn after a completed tool batch", async () => {
    const tools: AgentCoreToolDefinition[] = [
      {
        name: "read_file",
        description: "Read file.",
        run: async () => ({
          content: "contents",
        }),
      },
    ];

    const { events, result } = await collectQueryLoop(
      loopArgs({
        tools,
        maxTurns: 3,
        toolSummaryModel: scriptedModel([
          {
            content: "read_file completed",
          },
        ]),
        model: scriptedModel([
          {
            content: "",
            toolCalls: [
              {
                id: "call_read",
                name: "read_file",
                input: {
                  path: "README.md",
                },
              },
            ],
          },
          {
            content: "done",
          },
        ]),
      }),
    );

    expect(result.status).toBe("completed");
    expect(events).toContainEqual({
      type: "continue",
      continuation: {
        reason: "next_turn",
      },
      turn: 1,
      messageCount: 3,
    });
  });

  it("records stop_hook_blocking when a stop hook asks the loop to continue", async () => {
    const { events, result } = await collectQueryLoop(
      loopArgs({
        maxTurns: 2,
        hooks: [
          {
            name: "force-continue-once",
            phase: "stop",
            run: async () => ({
              action: "request-continue",
              reason: "Need one more model turn.",
            }),
          },
        ],
        model: scriptedModel([
          {
            content: "draft",
          },
          {
            content: "final",
          },
        ]),
      }),
    );

    expect(result.status).toBe("error");
    expect(events).toContainEqual({
      type: "continue",
      continuation: {
        reason: "stop_hook_blocking",
      },
      turn: 1,
      messageCount: 2,
    });
  });
});
