import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentCoreRecordedQueryLoop } from "../../src/agent-core/session/agent-core-session-recorded-query";
import { AgentCoreJsonlSessionStore } from "../../src/agent-core/session/agent-core-jsonl-session-store";
import type { AgentCoreMessage } from "../../src/agent-core/query-loop/agent-core-query-types";
import type { AgentCoreSessionEntry } from "../../src/agent-core/session/agent-core-session-types";

async function drain<T>(generator: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const item = await generator.next();
    if (item.done === true) {
      return item.value;
    }
  }
}

function messageContents(entries: readonly AgentCoreSessionEntry[]): string[] {
  return entries.filter((entry) => entry.kind === "message").map((entry) => entry.message.content);
}

describe("agent core recorded query loop", () => {
  it("appends only messages created after the persisted input history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-recorded-query-incremental-"));
    const store = new AgentCoreJsonlSessionStore({
      configDir: dir,
    });
    const handle = await store.createSession({
      sessionId: "session-1",
      cwd: dir,
      workspaceRoots: [dir],
    });
    const persistedMessage: AgentCoreMessage = {
      role: "user",
      content: "already persisted",
    };
    await store.appendMessage(
      handle,
      store.createMessageEntry({
        sessionId: handle.sessionId,
        cwd: handle.cwd,
        message: persistedMessage,
      }),
    );

    const result = await drain(
      runAgentCoreRecordedQueryLoop({
        cwd: dir,
        messages: [persistedMessage],
        session: {
          handle,
          store,
        },
        model: {
          complete: async () => ({
            content: "new answer",
          }),
        },
      }),
    );
    const entries = await store.readSession(handle);
    const budget = entries.findLast((entry) => entry.kind === "budget-event");

    expect(result.status).toBe("completed");
    expect(messageContents(entries)).toEqual(["already persisted", "new answer"]);
    expect(budget).toMatchObject({
      kind: "budget-event",
      messageCount: 2,
    });
  });

  it("can explicitly record the full result message chain for a new transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-recorded-query-full-"));
    const store = new AgentCoreJsonlSessionStore({
      configDir: dir,
    });
    const handle = await store.createSession({
      sessionId: "session-1",
      cwd: dir,
      workspaceRoots: [dir],
    });

    const result = await drain(
      runAgentCoreRecordedQueryLoop({
        cwd: dir,
        messages: [
          {
            role: "user",
            content: "new prompt",
          },
        ],
        recording: {
          messageStartIndex: 0,
        },
        session: {
          handle,
          store,
        },
        model: {
          complete: async () => ({
            content: "new answer",
          }),
        },
      }),
    );
    const entries = await store.readSession(handle);

    expect(result.status).toBe("completed");
    expect(messageContents(entries)).toEqual(["new prompt", "new answer"]);
    expect(entries.findLast((entry) => entry.kind === "budget-event")).toMatchObject({
      kind: "budget-event",
      messageCount: 2,
    });
  });
});
