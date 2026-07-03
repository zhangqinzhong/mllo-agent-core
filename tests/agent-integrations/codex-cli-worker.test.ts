import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createCodexCliWorker } from "../../src/agent-integrations/codex-cli";
import type { AgentCoreWorkerEvent } from "../../src/agent-core/workers/agent-core-worker-types";

type FakeCodexChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: number;
  kill: () => boolean;
};

function createFakeCodexChild(): FakeCodexChild {
  const child = new EventEmitter() as FakeCodexChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = 0;
  child.kill = () => {
    child.killed += 1;
    child.emit("close", null, "SIGTERM");
    return true;
  };
  return child;
}

describe("createCodexCliWorker", () => {
  it("exposes injected CLI availability checks for tool schema filtering", async () => {
    const calls: string[] = [];
    const worker = createCodexCliWorker({
      command: "codex-test",
      availabilityCheck(args) {
        calls.push(args.command);
        return {
          available: false,
          reason: "codex-test is not installed",
        };
      },
      spawnImpl() {
        throw new Error("spawn should not be called");
      },
    });

    await expect(Promise.resolve(worker.availability?.check?.())).resolves.toEqual({
      available: false,
      reason: "codex-test is not installed",
    });
    expect(calls).toEqual(["codex-test"]);
  });

  it("runs codex exec with stdin prompt and emits parsed worker events", async () => {
    const child = createFakeCodexChild();
    let stdin = "";
    child.stdin.on("data", (chunk: Buffer) => {
      stdin += chunk.toString("utf8");
    });
    const spawnCalls: {
      command: string;
      args: string[];
      cwd: string;
    }[] = [];
    const worker = createCodexCliWorker({
      command: "codex-test",
      spawnImpl(command, args, options) {
        spawnCalls.push({
          command,
          args,
          cwd: options.cwd,
        });
        queueMicrotask(() => {
          child.stdout.write(
            `${JSON.stringify({
              type: "agent_message_delta",
              delta: "codex says hello",
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              type: "exec_command_begin",
              command: "git status",
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              type: "exec_command_end",
              command: "git status",
              stdout: "clean",
              stderr: "",
              exit_code: 0,
              duration_ms: 42,
            })}\n`,
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    });
    const events: AgentCoreWorkerEvent[] = [];

    const result = await worker.run({
      prompt: "inspect repo",
      cwd: "/tmp/workspace",
      onEvent(event) {
        events.push(event);
      },
      requestPermission: async (request) => {
        events.push({
          type: "permission-request",
          workerId: "codex-cli",
          ...request,
        });
        return {
          status: "allow",
        };
      },
    });

    expect(spawnCalls).toEqual([
      {
        command: "codex-test",
        args: [
          "exec",
          "--json",
          "--color",
          "never",
          "--cd",
          "/tmp/workspace",
          "--sandbox",
          "workspace-write",
          "--config",
          'approval_policy="never"',
          "-",
        ],
        cwd: "/tmp/workspace",
      },
    ]);
    expect(stdin).toBe("inspect repo");
    expect(result.content).toBe("codex says hello");
    expect(events).toMatchObject([
      {
        type: "worker-start",
        workerId: "codex-cli",
      },
      {
        type: "permission-request",
        workerId: "codex-cli",
        requestId: "codex-cli-workspace-write",
        toolName: "codex_exec",
        capability: "shell-write",
      },
      {
        type: "assistant-delta",
        workerId: "codex-cli",
        content: "codex says hello",
      },
      {
        type: "tool-use",
        workerId: "codex-cli",
        invocationId: "codex-cli-tool-1",
        name: "shell_command",
        input: {
          command: "git status",
        },
      },
      {
        type: "permission-request",
        workerId: "codex-cli",
        requestId: "codex-cli-exec-1",
        toolName: "shell_command",
        capability: "shell-write",
      },
      {
        type: "permission-decision",
        workerId: "codex-cli",
        requestId: "codex-cli-exec-1",
        status: "allow",
      },
      {
        type: "tool-result",
        workerId: "codex-cli",
        invocationId: "codex-cli-tool-1",
        name: "shell_command",
        output: {
          command: "git status",
          stdout: "clean",
          stderr: "",
          exitCode: 0,
          durationMs: 42,
        },
        isError: false,
      },
      {
        type: "worker-done",
        workerId: "codex-cli",
        content: "codex says hello",
      },
    ]);
  });

  it("stops codex when an internal JSONL tool permission is denied", async () => {
    const child = createFakeCodexChild();
    const worker = createCodexCliWorker({
      command: "codex-test",
      spawnImpl() {
        queueMicrotask(() => {
          child.stdout.write(
            `${JSON.stringify({
              type: "exec_command_begin",
              command: "rm -rf tmp",
            })}\n`,
          );
        });
        return child;
      },
    });
    const events: AgentCoreWorkerEvent[] = [];

    const result = await worker.run({
      prompt: "danger",
      cwd: "/tmp/workspace",
      onEvent(event) {
        events.push(event);
      },
      requestPermission: async (request) => {
        events.push({
          type: "permission-request",
          workerId: "codex-cli",
          ...request,
        });
        return request.requestId === "codex-cli-workspace-write"
          ? {
              status: "allow",
            }
          : {
              status: "deny",
              reason: "user denied internal shell",
            };
      },
    });

    expect(result.content).toBe(
      "Codex CLI worker stopped because mllo denied internal tool permission.",
    );
    expect(result.status).toBe("denied");
    expect(child.killed).toBe(1);
    expect(events).toMatchObject([
      {
        type: "worker-start",
        workerId: "codex-cli",
      },
      {
        type: "permission-request",
        requestId: "codex-cli-workspace-write",
      },
      {
        type: "tool-use",
        workerId: "codex-cli",
        invocationId: "codex-cli-tool-1",
        name: "shell_command",
      },
      {
        type: "permission-request",
        requestId: "codex-cli-exec-1",
      },
      {
        type: "permission-decision",
        workerId: "codex-cli",
        requestId: "codex-cli-exec-1",
        status: "deny",
      },
      {
        type: "worker-done",
        workerId: "codex-cli",
      },
    ]);
  });
});
