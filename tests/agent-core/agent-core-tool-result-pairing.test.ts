import { describe, expect, it } from "vitest";
import { normalizeAgentCoreMessagesForWire } from "../../src/agent-core/model/agent-core-model-wire";
import { repairAgentCoreToolResultPairing } from "../../src/agent-core/query-loop/agent-core-tool-result-pairing";
import { runAgentCoreQueryLoop } from "../../src/agent-core/query-loop/agent-core-query-loop";
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
} from "../../src/agent-core/query-loop/agent-core-query-types";
import type {
  AgentCoreToolCall,
  AgentCoreToolDefinition,
} from "../../src/agent-core/tools/agent-core-tool-types";

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

  it("normalizes out-of-order tool results before model adapter wire conversion", () => {
    const call: AgentCoreToolCall = {
      id: "call_wire",
      name: "read_file",
      input: {
        path: "README.md",
      },
    };
    const normalized = normalizeAgentCoreMessagesForWire([
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
        content: "late user message",
      },
      {
        role: "tool",
        toolCallId: "call_wire",
        name: "read_file",
        content: "file contents",
      },
    ]);

    expect(messageRoles(normalized)).toEqual(["user", "assistant", "tool", "user"]);
    expect(normalized[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_wire",
      content: "file contents",
    });
  });

  it("renames model tool ids that were already used by earlier history", async () => {
    const reusedCall: AgentCoreToolCall = {
      id: "call_reused",
      name: "read_file",
      input: {
        path: "old.md",
      },
    };
    let toolInput: unknown;
    let streamCount = 0;
    const tool: AgentCoreToolDefinition = {
      name: "read_file",
      description: "Read a file.",
      run: async (input) => {
        toolInput = input;
        return {
          content: "new file contents",
        };
      },
    };

    const result = await drainAgentCoreGenerator(
      runAgentCoreQueryLoop({
        cwd: "/tmp/project",
        messages: [
          {
            role: "user",
            content: "read old file",
          },
          {
            role: "assistant",
            content: "",
            toolCalls: [reusedCall],
          },
          {
            role: "tool",
            toolCallId: "call_reused",
            name: "read_file",
            content: "old file contents",
          },
          {
            role: "user",
            content: "read another file",
          },
        ],
        tools: [tool],
        model: {
          stream: async function* () {
            streamCount += 1;
            if (streamCount === 1) {
              yield {
                type: "tool-call",
                call: {
                  id: "call_reused",
                  name: "read_file",
                  input: {
                    path: "new.md",
                  },
                },
              };
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
      }),
    );

    const assistantMessagesWithTools = result.messages.filter(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
    );
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    const newCall = assistantMessagesWithTools.at(-1)?.toolCalls?.[0];

    expect(result.status).toBe("completed");
    expect(toolInput).toEqual({
      path: "new.md",
    });
    expect(newCall).toMatchObject({
      id: "call_reused_2",
      idRepairStatus: {
        status: "duplicate-id-renamed",
        originalId: "call_reused",
        occurrence: 2,
      },
    });
    expect(toolMessages.map((message) => message.toolCallId)).toEqual([
      "call_reused",
      "call_reused_2",
    ]);
  });
});
