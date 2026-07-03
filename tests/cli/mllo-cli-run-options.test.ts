import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MlloStateStore } from "../../src/agent-core/runtime-state/mllo-state-store";
import type { MlloThreadRecord } from "../../src/agent-core/runtime-state/mllo-thread-records";
import { parseMlloCliArgs } from "../../src/cli/mllo-cli-args";
import { createMlloCliRunOptions } from "../../src/cli/mllo-cli-run-options";

async function writeTranscript(path: string): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await writeFile(path, "{}\n", "utf8");
}

function threadRecord(args: { id: string; cwd: string; rolloutPath: string }): MlloThreadRecord {
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
    updatedAtMs: 2,
  };
}

describe("createMlloCliRunOptions", () => {
  it("maps --continue to the latest resumable session", async () => {
    const home = await mkdtemp(join(tmpdir(), "mllo-cli-continue-"));
    const cwd = join(home, "project");
    const transcriptPath = join(home, "session.jsonl");
    await writeTranscript(transcriptPath);
    const state = new MlloStateStore({
      dbPath: join(home, "state.sqlite"),
    });
    try {
      state.upsertThread(
        threadRecord({
          id: "session-1",
          cwd,
          rolloutPath: transcriptPath,
        }),
      );
    } finally {
      state.close();
    }

    const options = await createMlloCliRunOptions({
      parsed: parseMlloCliArgs(["run", "--home", home, "--cwd", cwd, "--continue", "hello"]),
      input: "hello",
      handlers: {},
    });

    expect(options.session.sessionId).toBe("session-1");
    expect(options.session.resume).toBe(true);
  });
});
