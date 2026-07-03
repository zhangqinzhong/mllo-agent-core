import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MlloCliEventRenderer } from "../../src/cli/mllo-cli-event-renderer";

class MemoryWritable extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.chunks.push(String(chunk));
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

describe("MlloCliEventRenderer", () => {
  it("prints persisted output blob paths for truncated tool results", () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const renderer = new MlloCliEventRenderer({
      outputFormat: "text",
      stdout,
      stderr,
    });

    renderer.handleEvent({
      type: "tool-result",
      call: {
        id: "call_big",
        name: "shell_command",
        input: {
          command: "cat huge.log",
        },
      },
      result: {
        content: "<mllo_persisted_tool_output>...</mllo_persisted_tool_output>",
        outputTruncated: true,
        outputOriginalChars: 90_000,
        outputMaxChars: 2_000,
        outputBlobPath: "threads/session/tool-results/call_big.json",
        outputBlobBytes: 91_000,
      },
    });

    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain(
      "[mllo] tool shell_command output truncated: 2000/90000 chars, saved: threads/session/tool-results/call_big.json",
    );
  });
});
