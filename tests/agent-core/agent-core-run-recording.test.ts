import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordAgentCoreRunMessagesFrom } from "../../src/agent-core/runtime/agent-core-run-recording";
import type { AgentCorePreparedRunSession } from "../../src/agent-core/runtime/agent-core-run-session";
import { MlloStateStore } from "../../src/agent-core/runtime-state/mllo-state-store";
import { AgentCoreJsonlSessionStore } from "../../src/agent-core/session/agent-core-jsonl-session-store";

describe("agent core run recording", () => {
  it("appends a message-count checkpoint after recording new messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-run-recording-"));
    const store = new AgentCoreJsonlSessionStore({
      configDir: dir,
    });
    const stateStore = new MlloStateStore({
      dbPath: ":memory:",
    });
    try {
      const handle = await store.createSession({
        sessionId: "session-1",
        cwd: dir,
        workspaceRoots: [dir],
      });
      const session: AgentCorePreparedRunSession = {
        store,
        handle,
        stateStore,
        ownsStateStore: false,
        configDir: dir,
      };

      const nextIndex = await recordAgentCoreRunMessagesFrom({
        session,
        startIndex: 0,
        messages: [
          {
            role: "user",
            content: "first",
          },
          {
            role: "assistant",
            content: "second",
          },
        ],
      });
      const entries = await store.readSession(handle);

      expect(nextIndex).toBe(2);
      expect(entries.map((entry) => entry.kind)).toEqual([
        "session-metadata",
        "message",
        "message",
        "budget-event",
      ]);
      expect(entries.at(-1)).toMatchObject({
        kind: "budget-event",
        messageCount: 2,
      });
    } finally {
      stateStore.close();
    }
  });
});
