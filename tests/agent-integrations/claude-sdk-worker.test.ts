import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { createClaudeSdkWorker } from "../../src/agent-integrations/claude-sdk";

function fakeClaudeQuery(
  messages: unknown[] = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "claude says hello",
          },
        ],
      },
    },
  ],
): Query {
  const iterator = (async function* (): AsyncGenerator<unknown> {
    for (const message of messages) {
      yield message;
    }
  })();
  return Object.assign(iterator, {
    interrupt: vi.fn(),
  }) as unknown as Query;
}

describe("createClaudeSdkWorker", () => {
  it("uses dontAsk by default so delegated Claude cannot bypass mllo permissions", async () => {
    const queryImpl = vi.fn(() => fakeClaudeQuery());
    const worker = createClaudeSdkWorker({
      queryImpl,
    });

    const result = await worker.run({
      prompt: "inspect safely",
      cwd: "/tmp/workspace",
    });

    expect(result.content).toBe("claude says hello");
    expect(queryImpl).toHaveBeenCalledWith({
      prompt: "inspect safely",
      options: {
        cwd: "/tmp/workspace",
        permissionMode: "dontAsk",
      },
    });
  });

  it("asks mllo permission bridge before dangerous Claude Bash tool use", async () => {
    const queryImpl = vi.fn(() =>
      fakeClaudeQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu-bash-1",
                name: "Bash",
                input: {
                  command: "git status",
                },
              },
              {
                type: "text",
                text: "checked status",
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-bash-1",
                content: "On branch main",
                is_error: false,
              },
            ],
          },
        },
      ]),
    );
    const worker = createClaudeSdkWorker({
      queryImpl,
    });
    const events: unknown[] = [];

    const result = await worker.run({
      prompt: "inspect",
      cwd: "/tmp/workspace",
      onEvent(event) {
        events.push(event);
      },
      requestPermission: async (request) => {
        events.push({
          type: "permission-request",
          workerId: "claude-sdk",
          ...request,
        });
        return {
          status: "allow",
        };
      },
    });

    expect(result.content).toContain("[claude tool] Bash");
    expect(result.content).toContain("checked status");
    expect(events.slice(0, 4)).toMatchObject([
      {
        type: "worker-start",
        workerId: "claude-sdk",
      },
      {
        type: "permission-request",
        workerId: "claude-sdk",
        requestId: "toolu-bash-1",
        toolName: "Bash",
        capability: "shell-write",
      },
      {
        type: "tool-use",
        workerId: "claude-sdk",
        invocationId: "toolu-bash-1",
        name: "Bash",
      },
      {
        type: "permission-decision",
        workerId: "claude-sdk",
        requestId: "toolu-bash-1",
        status: "allow",
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        workerId: "claude-sdk",
        invocationId: "toolu-bash-1",
        name: "Bash",
        output: "On branch main",
        isError: false,
      }),
    );
  });

  it("interrupts Claude SDK when mllo denies dangerous tool permission", async () => {
    const query = fakeClaudeQuery([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-bash-deny",
              name: "Bash",
              input: {
                command: "rm -rf tmp",
              },
            },
          ],
        },
      },
    ]);
    const queryImpl = vi.fn(() => query);
    const worker = createClaudeSdkWorker({
      queryImpl,
    });
    const events: unknown[] = [];

    const result = await worker.run({
      prompt: "danger",
      cwd: "/tmp/workspace",
      onEvent(event) {
        events.push(event);
      },
      requestPermission: async (request) => {
        events.push({
          type: "permission-request",
          workerId: "claude-sdk",
          ...request,
        });
        return {
          status: "deny",
          reason: "user denied bash",
        };
      },
    });

    expect(result.content).toBe("Claude SDK worker stopped because mllo denied tool permission.");
    expect(result.status).toBe("denied");
    expect(query.interrupt).toHaveBeenCalled();
    expect(events).toMatchObject([
      {
        type: "worker-start",
        workerId: "claude-sdk",
      },
      {
        type: "permission-request",
        workerId: "claude-sdk",
        requestId: "toolu-bash-deny",
      },
      {
        type: "tool-use",
        workerId: "claude-sdk",
        invocationId: "toolu-bash-deny",
        name: "Bash",
      },
      {
        type: "permission-decision",
        workerId: "claude-sdk",
        status: "deny",
        reason: "user denied bash",
      },
      {
        type: "worker-error",
        workerId: "claude-sdk",
        message: "Claude SDK permission denied: user denied bash",
      },
      {
        type: "worker-done",
        workerId: "claude-sdk",
      },
    ]);
  });
});
