import type { MlloCliIo } from "./mllo-cli-io";
import type { MlloCliParsedArgs } from "./mllo-cli-types";
import { MlloCliEventRenderer } from "./mllo-cli-event-renderer";
import { createMlloCliInteraction } from "./mllo-cli-interaction";
import { consumeMlloCliAgentRun, createMlloCliRunOptions } from "./mllo-cli-run-options";
import { exitCodeFromMlloRunResult } from "./mllo-cli-exit-code";

export async function runMlloCliPrompt(args: {
  parsed: MlloCliParsedArgs;
  io: MlloCliIo;
  input: string;
  signal?: AbortSignal;
}): Promise<number> {
  if (args.input.trim().length === 0) {
    throw new Error("mllo run requires a prompt from argv or stdin.");
  }
  const interaction = createMlloCliInteraction({
    stdin: args.io.stdin,
    stderr: args.io.stderr,
    interactive: args.io.stdin.isTTY === true,
  });
  try {
    const renderer = new MlloCliEventRenderer({
      outputFormat: args.parsed.outputFormat,
      stdout: args.io.stdout,
      stderr: args.io.stderr,
    });
    const result = await consumeMlloCliAgentRun({
      options: createMlloCliRunOptions({
        parsed: args.parsed,
        input: args.input,
        handlers: interaction.handlers,
        signal: args.signal,
      }),
      sink: renderer,
    });
    renderer.finish(result);
    return exitCodeFromMlloRunResult(result);
  } finally {
    interaction.close();
  }
}
