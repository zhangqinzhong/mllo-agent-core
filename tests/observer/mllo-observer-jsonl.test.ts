import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readMlloObserverJsonlTail } from "../../src/observer/mllo-observer-jsonl";

describe("readMlloObserverJsonlTail", () => {
  it("reads a tail window and redacts sensitive fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-observer-"));
    const path = join(dir, "trace.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "init",
          apiKey: "secret-key",
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({ kind: "message", value: "hello" }),
        JSON.stringify({ kind: "tool", authorization: "Bearer abcdefghijklmnop" }),
      ].join("\n") + "\n",
    );

    const result = await readMlloObserverJsonlTail(path, {
      maxEntries: 2,
    });

    expect(result.exists).toBe(true);
    expect(result.truncatedHead).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]?.json).toContain("[redacted]");
    expect(result.entries[1]?.json).not.toContain("abcdefghijklmnop");
  });

  it("returns an empty result for a missing file", async () => {
    const result = await readMlloObserverJsonlTail("/tmp/mllo-observer-missing.jsonl");

    expect(result.exists).toBe(false);
    expect(result.entries).toEqual([]);
  });
});
