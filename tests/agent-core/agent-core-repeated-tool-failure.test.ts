import { describe, expect, it } from "vitest";
import { runAgentCoreQueryLoop } from "../../src/agent-core/query-loop/agent-core-query-loop";
import { createAgentCoreRepeatedToolFailureResult } from "../../src/agent-core/query-loop/agent-core-repeated-tool-failure";
import type { AgentCoreMessage } from "../../src/agent-core/query-loop/agent-core-query-types";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";

describe("agent core repeated tool failure guard", () => {
  it("blocks unchanged retry of an earlier failed tool call after intervening tool success", async () => {
    let readRuns = 0;
    let listRuns = 0;
    let streamCount = 0;
    const readTool: AgentCoreToolDefinition = {
      name: "read_file",
      description: "Read a file.",
      isConcurrencySafe: () => true,
      run: async () => {
        readRuns += 1;
        return {
          content: "No such file: missing.txt",
          isError: true,
        };
      },
    };
    const listTool: AgentCoreToolDefinition = {
      name: "list_dir",
      description: "List files.",
      isConcurrencySafe: () => true,
      run: async () => {
        listRuns += 1;
        return {
          content: "file README.md",
        };
      },
    };

    const loop = runAgentCoreQueryLoop({
      cwd: "/tmp/project",
      messages: [
        {
          role: "user",
          content: "read missing file",
        },
      ],
      tools: [readTool, listTool],
      model: {
        stream: async function* () {
          streamCount += 1;
          if (streamCount === 1) {
            yield {
              type: "tool-call",
              call: {
                id: "call_read_1",
                name: "read_file",
                input: {
                  path: "missing.txt",
                },
              },
            };
            yield {
              type: "message-end",
            };
            return;
          }
          if (streamCount === 2) {
            yield {
              type: "tool-call",
              call: {
                id: "call_list",
                name: "list_dir",
                input: {
                  path: ".",
                },
              },
            };
            yield {
              type: "message-end",
            };
            return;
          }
          if (streamCount === 3) {
            yield {
              type: "tool-call",
              call: {
                id: "call_read_2",
                name: "read_file",
                input: {
                  path: "missing.txt",
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
      maxTurns: 5,
    });

    let result;
    while (true) {
      const item = await loop.next();
      if (item.done === true) {
        result = item.value;
        break;
      }
    }

    const repeatedFailure = result.messages.find(
      (message) => message.role === "tool" && message.errorKind === "repeated-failure",
    );
    expect(result.status).toBe("completed");
    expect(readRuns).toBe(1);
    expect(listRuns).toBe(1);
    expect(repeatedFailure?.content).toContain("already has a failed tool result");
    expect(repeatedFailure?.content).toContain("No such file: missing.txt");
  });

  it("allows the same failed tool call after a new user message resets the autonomous loop", () => {
    const messages: AgentCoreMessage[] = [
      {
        role: "user",
        content: "first turn",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read_1",
            name: "read_file",
            input: {
              path: "missing.txt",
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read_1",
        name: "read_file",
        content: "No such file: missing.txt",
        isError: true,
      },
      {
        role: "user",
        content: "try again after I changed the file",
      },
    ];

    const result = createAgentCoreRepeatedToolFailureResult({
      messages,
      call: {
        id: "call_read_2",
        name: "read_file",
        input: {
          path: "missing.txt",
        },
      },
    });

    expect(result).toBeUndefined();
  });
});
