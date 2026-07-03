import { describe, expect, it } from "vitest";
import { repairAgentCoreToolResultPairing } from "../../src/agent-core/query-loop/agent-core-tool-result-pairing";
import { runAgentCoreQueryLoop } from "../../src/agent-core/query-loop/agent-core-query-loop";
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
} from "../../src/agent-core/query-loop/agent-core-query-types";
import type { AgentCoreToolCall } from "../../src/agent-core/tools/agent-core-tool-types";

async function drainAgentCoreGenerator<T>(
  generator: AsyncGenerator<AgentCoreQueryEvent, T>,
): Promise<T> {
  while (true) {
    const item = await generator.next();
    if (item.done === true) {
      return item.value;
    }
  }
}

function messageRoles(messages: readonly AgentCoreMessage[]): string[] {
  return messages.map((message) => message.role);
}

describe("agent core tool result pairing repair", () => {
  it("inserts a synthetic tool result immediately after an unpaired assistant tool call", () => {
    const call: AgentCoreToolCall = {
      id: "call_missing_result",
      name: "read_file",
      input: {
        path: "README.md",
      },
    };
    const repaired = repairAgentCoreToolResultPairing({
      messages: [
        {
          role: "user",
          content: "read file",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [call],
        },
        {
          role: "user",
          content: "continue",
        },
      ],
      reason: "Recovered missing tool result.",
    });

    expect(messageRoles(repaired.messages)).toEqual(["user", "assistant", "tool", "user"]);
    expect(repaired.repairedToolCallIds).toEqual(["call_missing_result"]);
    expect(repaired.repairedToolResults[0]?.result.errorKind).toBe("interrupted-tool-call");
    expect(repaired.messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_missing_result",
      content: "Recovered missing tool result.",
      isError: true,
      errorKind: "interrupted-tool-call",
    });
  });

  it("moves an out-of-order tool result back behind its assistant tool call", () => {
    const call: AgentCoreToolCall = {
      id: "call_late_result",
      name: "list_dir",
      input: {
        path: ".",
      },
    };
    const repaired = repairAgentCoreToolResultPairing({
      messages: [
        {
          role: "user",
          content: "list",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [call],
        },
        {
          role: "user",
          content: "this user message should stay after the tool result",
        },
        {
          role: "tool",
          toolCallId: "call_late_result",
          name: "list_dir",
          content: "file package.json",
        },
      ],
      reason: "Recovered missing tool result.",
    });

    expect(messageRoles(repaired.messages)).toEqual(["user", "assistant", "tool", "user"]);
    expect(repaired.repairedToolCallIds).toEqual([]);
    expect(repaired.messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_late_result",
      content: "file package.json",
    });
  });

  it("repairs incoming query-loop history before sending messages to the model", async () => {
    const call: AgentCoreToolCall = {
      id: "call_from_old_run",
      name: "read_file",
      input: {
        path: "README.md",
      },
    };
    let modelMessages: readonly AgentCoreMessage[] | undefined;
    const result = await drainAgentCoreGenerator(
      runAgentCoreQueryLoop({
        cwd: "/tmp/project",
        messages: [
          {
            role: "user",
            content: "previous prompt",
          },
          {
            role: "assistant",
            content: "",
            toolCalls: [call],
          },
          {
            role: "user",
            content: "continue from here",
          },
        ],
        model: {
          complete: async (request) => {
            modelMessages = [...request.messages];
            return {
              content: "done",
            };
          },
        },
        maxTurns: 1,
      }),
    );

    expect(result.status).toBe("completed");
    expect(modelMessages).toBeDefined();
    expect(messageRoles(modelMessages ?? [])).toEqual(["user", "assistant", "tool", "user"]);
    expect(modelMessages?.[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_from_old_run",
      errorKind: "interrupted-tool-call",
    });
    expect(messageRoles(result.messages)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
  });
});
