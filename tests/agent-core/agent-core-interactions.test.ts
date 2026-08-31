import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentCoreJsonlSessionStore,
  MlloStateStore,
  listPendingAgentCoreInteractions,
  reindexMlloState,
  submitAgentCoreInteractionResolution,
  type AgentCoreInteractionResolution,
} from "../../src";
import type { AgentCoreQueryLoopResult } from "../../src/agent-core/query-loop/agent-core-query-types";
import { recordAgentCorePendingInteraction } from "../../src/agent-core/runtime/agent-core-interactions";
import type { AgentCorePreparedRunSession } from "../../src/agent-core/runtime/agent-core-run-session";
import { resumeAgentCoreRunElicitation } from "../../src/agent-core/runtime/agent-core-run-elicitation";

async function drain<T>(generator: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const item = await generator.next();
    if (item.done === true) {
      return item.value;
    }
  }
}

async function createSession(args: { dir: string; stateDbPath: string }) {
  const sessionStore = new AgentCoreJsonlSessionStore({
    configDir: args.dir,
  });
  const handle = await sessionStore.createSession({
    sessionId: "session-1",
    cwd: args.dir,
    workspaceRoots: [args.dir],
  });
  const stateStore = new MlloStateStore({
    dbPath: args.stateDbPath,
  });
  const session: AgentCorePreparedRunSession = {
    store: sessionStore,
    handle,
    stateStore,
    ownsStateStore: false,
    configDir: args.dir,
  };
  return {
    sessionStore,
    stateStore,
    session,
    handle,
  };
}

function permissionWait(): Extract<AgentCoreQueryLoopResult, { status: "waiting-for-permission" }> {
  return {
    status: "waiting-for-permission",
    messages: [
      {
        role: "user",
        content: "run it",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "shell_command",
            input: {
              command: "echo ok",
              env: {
                API_TOKEN: "secret-value",
              },
            },
          },
        ],
      },
    ],
    call: {
      id: "call-1",
      name: "shell_command",
      input: {
        command: "echo ok",
        env: {
          API_TOKEN: "secret-value",
        },
      },
    },
    decision: {
      status: "ask",
      capability: "shell-write",
      reason: "Needs approval.",
      risk: {
        kind: "remote-secret-env",
        severity: "high",
        title: "Secret environment",
        detail: "The command forwards a secret.",
        names: ["API_TOKEN"],
      },
    },
  };
}

function elicitationWait(): Extract<
  AgentCoreQueryLoopResult,
  { status: "waiting-for-elicitation" }
> {
  return {
    status: "waiting-for-elicitation",
    messages: [
      {
        role: "user",
        content: "choose",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "ask-1",
            name: "ask_user",
            input: {},
          },
        ],
      },
    ],
    call: {
      id: "ask-1",
      name: "ask_user",
      input: {},
    },
    request: {
      question: "Pick one",
      options: ["A", "B"],
      allowFreeform: false,
    },
  };
}

describe("agent core durable interactions", () => {
  it("recovers pending permission state after reopen and makes resolution idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-interaction-permission-"));
    const stateDbPath = join(dir, "state.sqlite");
    const created = await createSession({ dir, stateDbPath });
    const pending = await recordAgentCorePendingInteraction({
      session: created.session,
      result: permissionWait(),
      messageCount: 2,
    });

    expect(pending).toMatchObject({
      kind: "permission",
      status: "pending",
      messageCount: 2,
    });
    expect(pending.request.call.input).toMatchObject({
      env: {
        API_TOKEN: "[redacted shell environment value]",
      },
    });
    created.stateStore.close();

    const reopenedState = new MlloStateStore({ dbPath: stateDbPath });
    const reopenedSession = new AgentCoreJsonlSessionStore({ configDir: dir });
    try {
      expect(
        listPendingAgentCoreInteractions({
          stateStore: reopenedState,
        }),
      ).toEqual([expect.objectContaining({ id: pending.id })]);

      const resolution = {
        kind: "permission" as const,
        decision: {
          status: "deny" as const,
          reason: "Not this time.",
        },
      };
      await expect(
        submitAgentCoreInteractionResolution({
          stateStore: reopenedState,
          sessionStore: reopenedSession,
          interactionId: pending.id,
          resolution,
        }),
      ).resolves.toMatchObject({
        status: "resolved",
        interaction: {
          status: "resolved",
          resolution,
        },
      });
      await expect(
        submitAgentCoreInteractionResolution({
          stateStore: reopenedState,
          sessionStore: reopenedSession,
          interactionId: pending.id,
          resolution,
        }),
      ).resolves.toMatchObject({ status: "already-resolved" });
      await expect(
        submitAgentCoreInteractionResolution({
          stateStore: reopenedState,
          sessionStore: reopenedSession,
          interactionId: pending.id,
          resolution: {
            kind: "permission",
            decision: {
              status: "allow",
            },
          },
        }),
      ).resolves.toMatchObject({ status: "conflict" });

      const entries = await reopenedSession.readSession(created.handle);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "interaction-request-event",
            interactionId: pending.id,
          }),
          expect.objectContaining({
            kind: "permission-event",
            interactionId: pending.id,
            resolutionSource: "external",
          }),
        ]),
      );
      expect(JSON.stringify(entries)).not.toContain("secret-value");
    } finally {
      reopenedState.close();
    }
  });

  it("reports invalid kind and unknown interaction without mutating pending state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-interaction-invalid-"));
    const stateDbPath = join(dir, "state.sqlite");
    const created = await createSession({ dir, stateDbPath });
    try {
      const pending = await recordAgentCorePendingInteraction({
        session: created.session,
        result: elicitationWait(),
        messageCount: 2,
      });
      const wrongKind = {
        kind: "permission",
        decision: {
          status: "allow",
        },
      } as AgentCoreInteractionResolution;

      await expect(
        submitAgentCoreInteractionResolution({
          stateStore: created.stateStore,
          sessionStore: created.sessionStore,
          interactionId: pending.id,
          resolution: wrongKind,
        }),
      ).resolves.toMatchObject({ status: "invalid-resolution" });
      await expect(
        submitAgentCoreInteractionResolution({
          stateStore: created.stateStore,
          sessionStore: created.sessionStore,
          interactionId: "missing",
          resolution: wrongKind,
        }),
      ).resolves.toEqual({
        status: "not-found",
        interactionId: "missing",
      });
      expect(created.stateStore.getInteraction(pending.id)?.status).toBe("pending");
    } finally {
      created.stateStore.close();
    }
  });

  it("rebuilds pending and resolved elicitation projections from JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-interaction-reindex-"));
    const sourceDbPath = join(dir, "source.sqlite");
    const rebuiltDbPath = join(dir, "rebuilt.sqlite");
    const created = await createSession({
      dir,
      stateDbPath: sourceDbPath,
    });
    const pending = await recordAgentCorePendingInteraction({
      session: created.session,
      result: elicitationWait(),
      messageCount: 2,
    });
    created.stateStore.close();

    const rebuilt = new MlloStateStore({ dbPath: rebuiltDbPath });
    try {
      const pendingReindex = await reindexMlloState({
        configDir: dir,
        stateStore: rebuilt,
        reset: true,
      });
      expect(pendingReindex).toMatchObject({
        indexedInteractions: 1,
        pendingInteractions: 1,
      });
      expect(rebuilt.getInteraction(pending.id)?.status).toBe("pending");

      const resolutionEntry = created.sessionStore.createElicitationEventEntry({
        sessionId: created.handle.sessionId,
        cwd: created.handle.cwd,
        call: elicitationWait().call,
        request: elicitationWait().request,
        response: {
          status: "answer",
          answer: "A",
        },
        interactionId: pending.id,
        resolutionSource: "external",
      });
      await created.sessionStore.appendEntry(created.handle, resolutionEntry);

      const resolvedReindex = await reindexMlloState({
        configDir: dir,
        stateStore: rebuilt,
        reset: true,
      });
      expect(resolvedReindex).toMatchObject({
        indexedInteractions: 1,
        pendingInteractions: 0,
      });
      expect(rebuilt.getInteraction(pending.id)).toMatchObject({
        status: "resolved",
        resolution: {
          kind: "elicitation",
          decision: {
            status: "answer",
            answer: "A",
          },
        },
      });
    } finally {
      rebuilt.close();
    }
  });

  it("keeps a one-argument elicitation callback compatible while exposing durable context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-interaction-callback-"));
    const created = await createSession({
      dir,
      stateDbPath: join(dir, "state.sqlite"),
    });
    try {
      const waiting = elicitationWait();
      const pending = await recordAgentCorePendingInteraction({
        session: created.session,
        result: waiting,
        messageCount: waiting.messages.length,
      });
      const messages = await drain(
        resumeAgentCoreRunElicitation({
          session: created.session,
          result: waiting,
          hooks: [],
          onElicitationRequest: async () => ({
            status: "answer",
            answer: "B",
          }),
          workers: [],
          interactionId: pending.id,
        }),
      );

      expect(messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "ask-1",
        content: "User answer:\nB",
      });
      expect(created.stateStore.getInteraction(pending.id)).toMatchObject({
        status: "resolved",
        resolutionSource: "callback",
      });
    } finally {
      created.stateStore.close();
    }
  });
});
