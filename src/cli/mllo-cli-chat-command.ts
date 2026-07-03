import type { MlloCliIo } from "./mllo-cli-io";
import { writeCliLine } from "./mllo-cli-io";
import type { MlloCliParsedArgs } from "./mllo-cli-types";
import { MlloCliEventRenderer } from "./mllo-cli-event-renderer";
import { createMlloCliInteraction, createMlloCliReadline } from "./mllo-cli-interaction";
import { consumeMlloCliAgentRun, createMlloCliRunOptions } from "./mllo-cli-run-options";
import { exitCodeFromMlloRunResult } from "./mllo-cli-exit-code";

function shouldExitChat(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "/exit" || normalized === "/quit";
}

function nextChatTurnArgs(
  parsed: MlloCliParsedArgs,
  sessionId: string | undefined,
): MlloCliParsedArgs {
  return {
    ...parsed,
    command: "chat",
    promptParts: [],
    ...(sessionId === undefined
      ? {}
      : {
          sessionId: undefined,
          resumeSessionId: sessionId,
        }),
  };
}

export async function runMlloCliChat(args: {
  parsed: MlloCliParsedArgs;
  io: MlloCliIo;
  signal?: AbortSignal;
}): Promise<number> {
  if (args.io.stdin.isTTY !== true) {
    throw new Error("mllo chat requires an interactive TTY.");
  }
  const readline = createMlloCliReadline({
    stdin: args.io.stdin,
    stderr: args.io.stderr,
  });
  const interaction = createMlloCliInteraction({
    readline,
    stdin: args.io.stdin,
    stderr: args.io.stderr,
    interactive: true,
  });
  let sessionId = args.parsed.resumeSessionId ?? args.parsed.sessionId;
  let lastExitCode = 0;
  try {
    writeCliLine(args.io.stderr, "mllo chat. Type /exit to quit.");
    while (true) {
      const input = await interaction.question("mllo> ");
      if (shouldExitChat(input)) {
        return lastExitCode;
      }
      if (input.trim().length === 0) {
        continue;
      }
      const renderer = new MlloCliEventRenderer({
        outputFormat: args.parsed.outputFormat,
        stdout: args.io.stdout,
        stderr: args.io.stderr,
      });
      const result = await consumeMlloCliAgentRun({
        options: createMlloCliRunOptions({
          parsed: nextChatTurnArgs(args.parsed, sessionId),
          input,
          handlers: interaction.handlers,
          signal: args.signal,
        }),
        sink: renderer,
      });
      renderer.finish(result);
      sessionId = result.session.sessionId;
      lastExitCode = exitCodeFromMlloRunResult(result);
    }
  } finally {
    readline.close();
  }
}
