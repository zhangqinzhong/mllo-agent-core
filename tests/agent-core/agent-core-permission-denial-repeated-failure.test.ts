import { describe, expect, it } from "vitest";
import { resumeAgentCorePermissionDecision } from "../../src/agent-core/query-loop/agent-core-permission-resume";
import { runAgentCoreQueryLoop } from "../../src/agent-core/query-loop/agent-core-query-loop";
import { createAgentCoreRepeatedToolFailureResult } from "../../src/agent-core/query-loop/agent-core-repeated-tool-failure";
import type {
  AgentCoreQueryEvent,
  AgentCoreQueryLoopResult,
} from "../../src/agent-core/query-loop/agent-core-query-types";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";

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

async function collectAgentCoreGenerator<T>(
  generator: AsyncGenerator<AgentCoreQueryEvent, T>,
): Promise<{
  events: AgentCoreQueryEvent[];
  result: T;
}> {
  const events: AgentCoreQueryEvent[] = [];
  while (true) {
    const item = await generator.next();
    if (item.done === true) {
      return {
        events,
        result: item.value,
      };
    }
    events.push(item.value);
  }
}

describe("agent core permission denial repeated failure guard", () => {
  it("records automatic permission denial as a tool result before unchanged retry guard runs", async () => {
    let permissionChecks = 0;
    let writeRuns = 0;
    let secondRunStreamCount = 0;
    const writeTool: AgentCoreToolDefinition = {
      name: "write_file",
      description: "Write a file.",
      evaluatePermission: () => {
        permissionChecks += 1;
        return {
          status: "deny",
          capability: "file-write",
          reason: "Writing locked.txt is blocked by policy.",
        };
      },
      run: async () => {
        writeRuns += 1;
        return {
          content: "wrote",
        };
      },
    };

    const first = await drainAgentCoreGenerator(
      runAgentCoreQueryLoop({
        cwd: "/tmp/project",
        messages: [
          {
            role: "user",
            content: "write locked file",
          },
        ],
        tools: [writeTool],
        model: {
          stream: async function* () {
            yield {
              type: "tool-call",
              call: {
                id: "call_write_1",
                name: "write_file",
                input: {
                  path: "locked.txt",
                  content: "no",
                },
              },
            };
            yield {
              type: "message-end",
            };
          },
        },
        maxTurns: 2,
      }),
    );

    expect(first.status).toBe("denied");
    expect(permissionChecks).toBe(1);
    expect(writeRuns).toBe(0);
    const deniedToolResult = first.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call_write_1",
    );
    expect(deniedToolResult?.content).toBe("Writing locked.txt is blocked by policy.");
    expect(deniedToolResult?.isError).toBe(true);
    expect(deniedToolResult?.errorKind).toBe("permission-denied");

    const second = await drainAgentCoreGenerator(
      runAgentCoreQueryLoop({
        cwd: "/tmp/project",
        messages: first.messages,
        tools: [writeTool],
        model: {
          stream: async function* () {
            secondRunStreamCount += 1;
            if (secondRunStreamCount === 1) {
              yield {
                type: "tool-call",
                call: {
                  id: "call_write_2",
                  name: "write_file",
                  input: {
                    path: "locked.txt",
                    content: "no",
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

    expect(second.status).toBe("completed");
    expect(permissionChecks).toBe(1);
    expect(writeRuns).toBe(0);
    const repeatedFailure = second.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call_write_2",
    );
    expect(repeatedFailure?.errorKind).toBe("repeated-failure");
    expect(repeatedFailure?.content).toContain(
      "already has a failed tool result for the same tool name and JSON arguments",
    );
    expect(repeatedFailure?.content).toContain("Writing locked.txt is blocked by policy.");
  });

  it("keeps permission resume denial visible to the repeated failure guard", async () => {
    const call = {
      id: "call_write_permission",
      name: "write_file",
      input: {
        path: "locked.txt",
        content: "no",
      },
    };
    const waitingResult: Extract<AgentCoreQueryLoopResult, { status: "waiting-for-permission" }> = {
      status: "waiting-for-permission",
      messages: [
        {
          role: "user",
          content: "write locked file",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [call],
        },
      ],
      call,
      decision: {
        status: "ask",
        capability: "file-write",
        reason: "Write locked.txt?",
      },
    };

    const resumed = await drainAgentCoreGenerator(
      resumeAgentCorePermissionDecision({
        waitingResult,
        cwd: "/tmp/project",
        tools: [],
        decision: {
          status: "deny",
          reason: "User rejected the write.",
        },
      }),
    );

    const deniedToolResult = resumed.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call_write_permission",
    );
    expect(deniedToolResult?.content).toBe("Permission denied by user: User rejected the write.");
    expect(deniedToolResult?.isError).toBe(true);
    expect(deniedToolResult?.errorKind).toBe("permission-denied");

    const repeatedFailure = createAgentCoreRepeatedToolFailureResult({
      messages: resumed.messages,
      call: {
        ...call,
        id: "call_write_retry",
      },
    });
    expect(repeatedFailure?.errorKind).toBe("repeated-failure");
    expect(repeatedFailure?.content).toContain(
      "Permission denied by user: User rejected the write.",
    );
  });

  it("pauses again when permission resume reaches another gated tool", async () => {
    const firstCall = {
      id: "call_write_first",
      name: "write_file",
      input: {
        path: "first.txt",
        content: "one",
      },
    };
    const secondCall = {
      id: "call_write_second",
      name: "write_file",
      input: {
        path: "second.txt",
        content: "two",
      },
    };
    const waitingResult: Extract<AgentCoreQueryLoopResult, { status: "waiting-for-permission" }> = {
      status: "waiting-for-permission",
      messages: [
        {
          role: "user",
          content: "write two files",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [firstCall, secondCall],
        },
      ],
      call: firstCall,
      decision: {
        status: "ask",
        capability: "file-write",
        reason: "Write first.txt?",
      },
    };
    const writes: string[] = [];
    const writeTool: AgentCoreToolDefinition = {
      name: "write_file",
      description: "Write a file.",
      evaluatePermission: (input) => ({
        status: "ask",
        capability: "file-write",
        reason: `Write ${(input as { path?: string }).path ?? "file"}?`,
      }),
      run: async (input) => {
        writes.push((input as { path: string }).path);
        return {
          content: `wrote ${(input as { path: string }).path}`,
        };
      },
    };

    const { events, result } = await collectAgentCoreGenerator(
      resumeAgentCorePermissionDecision({
        waitingResult,
        cwd: "/tmp/project",
        tools: [writeTool],
        decision: {
          status: "allow",
        },
      }),
    );

    expect(result.status).toBe("waiting-for-permission");
    if (result.status !== "waiting-for-permission") {
      throw new Error("expected another permission pause");
    }
    expect(result.call.id).toBe("call_write_second");
    expect(result.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "call_write_first",
        content: "wrote first.txt",
      }),
    );
    expect(
      result.messages.some(
        (message) => message.role === "tool" && message.toolCallId === "call_write_second",
      ),
    ).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "permission-required",
        call: expect.objectContaining({
          id: "call_write_second",
        }),
      }),
    );
    expect(writes).toEqual(["first.txt"]);
  });
});
