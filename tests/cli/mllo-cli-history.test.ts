import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAgentCoreInputHistoryEntry } from "../../src/agent-core/session/agent-core-input-history";
import { MlloStateStore } from "../../src/agent-core/runtime-state/mllo-state-store";
import type { MlloThreadRecord } from "../../src/agent-core/runtime-state/mllo-thread-records";
import { parseMlloCliArgs } from "../../src/cli/mllo-cli-args";
import { loadMlloCliReadlineHistory } from "../../src/cli/mllo-cli-history";

async function appendInput(args: {
  home: string;
  sessionId: string;
  cwd: string;
  input: string;
}): Promise<void> {
  await appendAgentCoreInputHistoryEntry({
    configDir: args.home,
    sessionId: args.sessionId,
    cwd: args.cwd,
    input: args.input,
  });
}

async function writeTranscript(path: string): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await writeFile(path, "{}\n", "utf8");
}

function threadRecord(args: {
  id: string;
  cwd: string;
  rolloutPath: string;
  updatedAtMs: number;
}): MlloThreadRecord {
  return {
    id: args.id,
    rolloutPath: args.rolloutPath,
    cwd: args.cwd,
    title: args.id,
    modelProvider: "test",
    approvalMode: "ask",
    sandboxPolicy: "workspace-write",
    tokensUsed: 0,
    resumeOmittedEntries: 0,
    resumeOmittedBytes: 0,
    runStatus: "completed",
    archived: false,
    preview: "",
    createdAtMs: 1,
    updatedAtMs: args.updatedAtMs,
  };
}

describe("loadMlloCliReadlineHistory", () => {
  it("loads cwd history with the resumed session first", async () => {
    const home = await mkdtemp(join(tmpdir(), "mllo-cli-history-"));
    const cwd = join(home, "project");
    await appendInput({
      home,
      sessionId: "current",
      cwd,
      input: "current old",
    });
    await appendInput({
      home,
      sessionId: "other",
      cwd,
      input: "other newer",
    });
    await appendInput({
      home,
      sessionId: "current",
      cwd,
      input: "current newest",
    });

    const history = await loadMlloCliReadlineHistory({
      parsed: parseMlloCliArgs(["chat", "--home", home, "--cwd", cwd, "--resume", "current"]),
    });

    expect(history).toEqual(["current newest", "current old", "other newer"]);
  });

  it("resolves --continue before loading history", async () => {
    const home = await mkdtemp(join(tmpdir(), "mllo-cli-history-continue-"));
    const cwd = join(home, "project");
    const firstTranscript = join(home, "first.jsonl");
    const secondTranscript = join(home, "second.jsonl");
    await Promise.all([writeTranscript(firstTranscript), writeTranscript(secondTranscript)]);
    await appendInput({
      home,
      sessionId: "first",
      cwd,
      input: "first session prompt",
    });
    await appendInput({
      home,
      sessionId: "second",
      cwd,
      input: "second session prompt",
    });
    const state = new MlloStateStore({
      dbPath: join(home, "state.sqlite"),
    });
    try {
      state.upsertThread(
        threadRecord({
          id: "first",
          cwd,
          rolloutPath: firstTranscript,
          updatedAtMs: 10,
        }),
      );
      state.upsertThread(
        threadRecord({
          id: "second",
          cwd,
          rolloutPath: secondTranscript,
          updatedAtMs: 20,
        }),
      );
    } finally {
      state.close();
    }

    const history = await loadMlloCliReadlineHistory({
      parsed: parseMlloCliArgs(["chat", "--home", home, "--cwd", cwd, "--continue"]),
    });

    expect(history).toEqual(["second session prompt", "first session prompt"]);
  });
});
