import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearMlloDumpPromptsState,
  createMlloDumpPromptsFetch,
  flushMlloDumpPromptWrites,
} from "../../src/agent-core/model/agent-core-dump-prompts-fetch";
import { readAgentCoreJsonlWindow } from "../../src/agent-core/session/agent-core-jsonl-window-reader";
import { readLatestAgentCorePlanJournal } from "../../src/agent-core/tools/agent-core-plan-journal";
import { runAgentCoreQueryLoop } from "../../src/agent-core/query-loop/agent-core-query-loop";
import { AGENT_CORE_TOOL_RESULTS_PER_TURN_MAX_CHARS } from "../../src/agent-core/query-loop/agent-core-tool-result-turn-budget";
import {
  readAgentCoreToolResultBlob,
  writeAgentCoreToolResultBlob,
} from "../../src/agent-core/tools/agent-core-tool-result-blob-store";
import { readLatestAgentCoreShellTaskJournal } from "../../src/agent-core/tools/shell-task-journal";
import { readAgentCoreShellCwdState } from "../../src/agent-core/tools/shell-cwd-state";
import { evaluateAgentCorePathPermission } from "../../src/agent-core/permissions/workspace-path-policy";
import { restoreAgentCoreCheckpointRecord } from "../../src/agent-core/checkpoint/agent-core-checkpoint-restore";
import { createAgentCoreToolCall } from "../../src/agent-core/model/agent-core-model-wire";
import type { AgentCoreSessionEntry } from "../../src/agent-core/session/agent-core-session-types";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";
import type { AgentCoreCheckpointRecord } from "../../src/agent-core/checkpoint/agent-core-checkpoint-store";

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await writeFile(path, content, "utf8");
}

function messageEntry(sessionId: string, content: string): AgentCoreSessionEntry {
  return {
    kind: "message",
    uuid: `uuid-${content}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId,
    cwd: "/tmp/project",
    message: {
      role: "user",
      content,
    },
  };
}

describe("agent core reliability guards", () => {
  it("reads tail JSONL windows without parsing a chunk-boundary fragment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-window-"));
    const path = join(dir, "session.jsonl");
    const giantEntry = messageEntry("s1", "x".repeat(70 * 1024));
    const entries = [
      messageEntry("s1", "first"),
      giantEntry,
      messageEntry("s1", "third"),
      messageEntry("s1", "fourth"),
    ];
    await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const window = await readAgentCoreJsonlWindow({
      path,
      headEntries: 0,
      tailEntries: 3,
    });

    expect(
      window.tail.map(
        (entry) => (entry as Extract<AgentCoreSessionEntry, { kind: "message" }>).message.content,
      ),
    ).toEqual([giantEntry.message.content, "third", "fourth"]);
  });

  it("dumps model responses even when the caller consumes the original body first", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "mllo-dump-"));
    clearMlloDumpPromptsState();
    const wrappedFetch = createMlloDumpPromptsFetch({
      homePath,
      sessionId: "session-1",
      env: {
        MLLO_DUMP_PROMPTS: "1",
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: "response-1", content: "ok" }), {
          headers: {
            "content-type": "application/json",
          },
        }),
    });

    const response = await wrappedFetch("http://127.0.0.1/model", {
      method: "POST",
      body: JSON.stringify({
        model: "local",
        messages: [
          {
            role: "user",
            content: "hello",
          },
        ],
      }),
    });
    await response.text();
    await flushMlloDumpPromptWrites();

    const dump = await readFile(join(homePath, "dump-prompts", "session-1.jsonl"), "utf8");
    expect(dump).toContain('"type":"response"');
    expect(dump).toContain("response-1");
  });

  it("skips corrupted journal lines during runtime-state recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-journal-"));
    const planPath = join(dir, "plan.jsonl");
    const shellPath = join(dir, "shell_tasks.jsonl");
    await writeText(
      planPath,
      [
        JSON.stringify({
          kind: "plan",
          recordedAt: Date.now(),
          plan: {
            items: [
              {
                step: "first",
                status: "completed",
              },
            ],
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        "{bad json",
        JSON.stringify({
          kind: "plan",
          recordedAt: Date.now(),
          plan: {
            items: [
              {
                step: "latest",
                status: "in_progress",
              },
            ],
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        }),
      ].join("\n"),
    );
    await writeText(
      shellPath,
      [
        "{bad json",
        JSON.stringify({
          kind: "shell-task",
          recordedAt: Date.now(),
          task: {
            taskId: "task-1",
            command: "echo ok",
            cwd: dir,
            status: "completed",
            startedAt: Date.now(),
            updatedAt: Date.now(),
          },
        }),
      ].join("\n"),
    );

    await expect(readLatestAgentCorePlanJournal({ journalPath: planPath })).resolves.toMatchObject({
      items: [
        {
          step: "latest",
        },
      ],
    });
    await expect(
      readLatestAgentCoreShellTaskJournal({ journalPath: shellPath }),
    ).resolves.toHaveLength(1);
  });

  it("falls back to the workspace cwd when shell cwd state is corrupted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-cwd-"));
    const statePath = join(dir, "shell_cwd.json");
    await writeFile(statePath, "{bad json", "utf8");

    await expect(
      readAgentCoreShellCwdState({
        statePath,
        fallbackCwd: dir,
      }),
    ).resolves.toBe(dir);
  });

  it("denies file paths outside workspace roots before execution", () => {
    const dir = "/tmp/mllo-workspace";
    const decision = evaluateAgentCorePathPermission(
      {
        mode: "ask",
        cwd: dir,
        workspaceRoots: [dir],
      },
      "/tmp/outside-workspace/file.txt",
      "read",
    );

    expect(decision.status).toBe("deny");
  });

  it("does not silently restore legacy checkpoints without post-write tracking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-checkpoint-"));
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "agent write or later edit", "utf8");
    const record: AgentCoreCheckpointRecord = {
      checkpointId: "checkpoint-1",
      sessionId: "session-1",
      cwd: dir,
      prompt: "restore",
      createdAt: "2026-01-01T00:00:00.000Z",
      files: [
        {
          path: "file.txt",
          resolvedPath: filePath,
          previousContent: "original",
        },
      ],
    };

    const result = await restoreAgentCoreCheckpointRecord(record);

    expect(result.files[0]).toMatchObject({
      action: "conflict",
    });
    await expect(readFile(filePath, "utf8")).resolves.toBe("agent write or later edit");
  });

  it("aborts pre-executed tools when a model stream fails mid-turn", async () => {
    let toolWasAborted = false;
    const tool: AgentCoreToolDefinition = {
      name: "slow_read",
      description: "Slow read tool.",
      isConcurrencySafe: () => true,
      run: async (_input, context) =>
        await new Promise((resolve) => {
          context.signal?.addEventListener(
            "abort",
            () => {
              toolWasAborted = true;
              resolve({
                content: "aborted",
                isError: true,
              });
            },
            {
              once: true,
            },
          );
        }),
    };

    const events = [];
    const result = await (async () => {
      const loop = runAgentCoreQueryLoop({
        cwd: "/tmp/project",
        messages: [
          {
            role: "user",
            content: "run tool",
          },
        ],
        tools: [tool],
        model: {
          stream: async function* () {
            yield {
              type: "tool-call",
              call: {
                id: "tool-1",
                name: "slow_read",
                input: {},
              },
            };
            throw new Error("stream failed");
          },
        },
        maxTurns: 1,
      });
      while (true) {
        const item = await loop.next();
        if (item.done === true) {
          return item.value;
        }
        events.push(item.value);
      }
    })();

    expect(result.status).toBe("error");
    expect(toolWasAborted).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("caps aggregate tool result content within one assistant turn", async () => {
    let streamCount = 0;
    const storedBlobs: Array<{
      toolCallId: string;
      content: string;
      originalChars: number;
    }> = [];
    const outputByName = new Map([
      ["first", "a".repeat(150_000)],
      ["second", "b".repeat(90_000)],
      ["third", "c".repeat(1_000)],
    ]);
    const tool: AgentCoreToolDefinition = {
      name: "big_read",
      description: "Return large output.",
      run: async (input) => ({
        content: outputByName.get((input as { name: string }).name) ?? "",
      }),
    };

    const loop = runAgentCoreQueryLoop({
      cwd: "/tmp/project",
      messages: [
        {
          role: "user",
          content: "read lots",
        },
      ],
      tools: [tool],
      model: {
        stream: async function* () {
          streamCount += 1;
          if (streamCount === 1) {
            for (const name of ["first", "second", "third"]) {
              yield {
                type: "tool-call",
                call: {
                  id: `call_${name}`,
                  name: "big_read",
                  input: {
                    name,
                  },
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
      storeToolResultBlob: async ({ call, content, originalChars }) => {
        storedBlobs.push({
          toolCallId: call.id,
          content,
          originalChars,
        });
        return {
          outputBlobPath: `blob/${call.id}.json`,
          outputBlobBytes: Buffer.byteLength(content, "utf8"),
        };
      },
    });

    const result = await (async () => {
      while (true) {
        const item = await loop.next();
        if (item.done === true) {
          return item.value;
        }
      }
    })();

    expect(result.status).toBe("completed");
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0]?.content.length).toBe(150_000);
    expect(toolMessages[1]?.content).toContain(
      "[tool result truncated by aggregate turn budget for big_read]",
    );
    expect(toolMessages[1]?.content).toContain("keptChars: 50000");
    expect(toolMessages[2]?.content).toContain("keptChars: 0");
    expect(toolMessages[1]).toMatchObject({
      outputTruncated: true,
      outputOriginalChars: 90_000,
      outputBlobPath: "blob/call_second.json",
    });
    expect(toolMessages[2]).toMatchObject({
      outputTruncated: true,
      outputOriginalChars: 1_000,
      outputBlobPath: "blob/call_third.json",
    });
    expect(storedBlobs).toEqual([
      {
        toolCallId: "call_second",
        content: "b".repeat(90_000),
        originalChars: 90_000,
      },
      {
        toolCallId: "call_third",
        content: "c".repeat(1_000),
        originalChars: 1_000,
      },
    ]);
    expect(toolMessages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThan(
      AGENT_CORE_TOOL_RESULTS_PER_TURN_MAX_CHARS + 1_000,
    );
  });

  it("stores full truncated tool result blobs under the session runtime path", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "mllo-tool-blob-"));
    const content = "full output\n".repeat(1_000);
    const stored = await writeAgentCoreToolResultBlob({
      projectDir,
      sessionId: "session/with unsafe chars",
      cwd: "/tmp/project",
      toolCallId: "call_read",
      toolName: "read_file",
      content,
      originalChars: content.length + 10,
    });

    const blob = await readAgentCoreToolResultBlob({
      projectDir,
      relativePath: stored.relativePath,
    });

    expect(stored.relativePath).toContain("threads/session-with-unsafe-chars/tool-results/");
    expect(stored.byteLength).toBeGreaterThan(content.length);
    expect(blob).toMatchObject({
      version: 1,
      sessionId: "session/with unsafe chars",
      cwd: "/tmp/project",
      toolCallId: "call_read",
      toolName: "read_file",
      content,
      originalChars: content.length + 10,
    });
    await expect(
      readAgentCoreToolResultBlob({
        projectDir,
        relativePath: "../escape.json",
      }),
    ).rejects.toThrow("Tool result blob path escapes mllo project storage.");
  });

  it("does not pre-execute repaired streaming tool calls before the model turn closes", async () => {
    let modelTurnClosed = false;
    let toolRanBeforeModelTurnClosed = false;
    let streamCount = 0;
    const tool: AgentCoreToolDefinition = {
      name: "read_snapshot",
      description: "Read a stable snapshot.",
      isConcurrencySafe: () => true,
      run: async () => {
        toolRanBeforeModelTurnClosed = !modelTurnClosed;
        return {
          content: "snapshot",
        };
      },
    };

    const loop = runAgentCoreQueryLoop({
      cwd: "/tmp/project",
      messages: [
        {
          role: "user",
          content: "read",
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
                id: "tool-1",
                name: "read_snapshot",
                input: {
                  path: "file.txt",
                },
                inputParseStatus: {
                  status: "repaired-truncated-json",
                  rawPreview: '{"path":"file.txt"',
                },
              },
            };
            await Promise.resolve();
            modelTurnClosed = true;
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
    });

    let result;
    while (true) {
      const item = await loop.next();
      if (item.done === true) {
        result = item.value;
        break;
      }
    }

    expect(result.status).toBe("completed");
    expect(toolRanBeforeModelTurnClosed).toBe(false);
  });

  it("normalizes duplicate streaming tool call ids before recording tool results", async () => {
    const toolInputs: unknown[] = [];
    let streamCount = 0;
    const tool: AgentCoreToolDefinition = {
      name: "echo",
      description: "Echo the input.",
      isConcurrencySafe: () => true,
      run: async (input) => {
        toolInputs.push(input);
        return {
          content: JSON.stringify(input),
        };
      },
    };

    const events = [];
    const loop = runAgentCoreQueryLoop({
      cwd: "/tmp/project",
      messages: [
        {
          role: "user",
          content: "run duplicate ids",
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
                id: "call_same",
                name: "echo",
                input: {
                  value: 1,
                },
              },
            };
            yield {
              type: "tool-call",
              call: {
                id: "call_same",
                name: "echo",
                input: {
                  value: 2,
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
    });

    let result;
    while (true) {
      const item = await loop.next();
      if (item.done === true) {
        result = item.value;
        break;
      }
      events.push(item.value);
    }

    const assistantWithTools = result.messages.find(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
    );
    const toolMessages = result.messages.filter((message) => message.role === "tool");

    expect(result.status).toBe("completed");
    expect(toolInputs).toEqual([
      {
        value: 1,
      },
      {
        value: 2,
      },
    ]);
    expect(assistantWithTools?.toolCalls?.map((call) => call.id)).toEqual([
      "call_same",
      "call_same_2",
    ]);
    expect(assistantWithTools?.toolCalls?.[1]?.idRepairStatus).toEqual({
      status: "duplicate-id-renamed",
      originalId: "call_same",
      occurrence: 2,
    });
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(["call_same", "call_same_2"]);
    expect(
      events.filter((event) => event.type === "tool-call").map((event) => event.call.id),
    ).toEqual(["call_same", "call_same_2"]);
  });

  it("runs whitelisted repaired tool input aliases through the query loop", async () => {
    let receivedInput: unknown;
    let streamCount = 0;
    const tool: AgentCoreToolDefinition = {
      name: "read_file",
      description: "Read a file.",
      isConcurrencySafe: () => true,
      run: async (input) => {
        receivedInput = input;
        return {
          content: "file content",
        };
      },
    };

    const loop = runAgentCoreQueryLoop({
      cwd: "/tmp/project",
      messages: [
        {
          role: "user",
          content: "read file",
        },
      ],
      tools: [tool],
      model: {
        stream: async function* () {
          streamCount += 1;
          if (streamCount === 1) {
            yield {
              type: "tool-call",
              call: createAgentCoreToolCall({
                id: "call_alias",
                index: 0,
                name: "read_file",
                arguments: {
                  file_path: "README.md",
                },
              }),
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
    });

    let result;
    while (true) {
      const item = await loop.next();
      if (item.done === true) {
        result = item.value;
        break;
      }
    }

    const assistantWithTools = result.messages.find(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
    );

    expect(result.status).toBe("completed");
    expect(receivedInput).toEqual({
      path: "README.md",
    });
    expect(assistantWithTools?.toolCalls?.[0]?.inputRepairStatus).toEqual({
      status: "parameter-alias-renamed",
      repairs: [
        {
          from: "file_path",
          to: "path",
        },
      ],
    });
  });
});
