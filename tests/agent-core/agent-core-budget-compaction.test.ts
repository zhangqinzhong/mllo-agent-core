import { describe, expect, it } from "vitest";
import { applyAgentCoreBudget } from "../../src/agent-core/budget/agent-core-budget-engine";
import type { AgentCoreMessage } from "../../src/agent-core/query-loop/agent-core-query-types";

describe("agent core budget compaction", () => {
  it("keeps assistant tool calls with retained tool results when compacting the tail", async () => {
    const messages: AgentCoreMessage[] = [
      {
        role: "user",
        content: "old context",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_list",
            name: "list_dir",
            input: {
              path: ".",
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_list",
        name: "list_dir",
        content: "file package.json",
      },
      {
        role: "user",
        content: "continue",
      },
    ];
    let summarized: readonly AgentCoreMessage[] = [];

    const result = await applyAgentCoreBudget({
      messages,
      policy: {
        maxInputTokens: 1,
        compactTriggerRatio: 0,
        preservedTailMessages: 2,
      },
      summarizer: {
        summarize: async (input) => {
          summarized = input;
          return "old summary";
        },
      },
    });

    expect(result.compacted).toBe(true);
    expect(summarized.map((message) => message.role)).toEqual(["user"]);
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(result.record.boundary.retainedMessageCount).toBe(3);
    expect(result.record.boundary.summarizedMessageCount).toBe(1);
    expect(result.messages[1]).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call_list",
        },
      ],
    });
    expect(result.messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_list",
      content: "file package.json",
    });
  });
});
