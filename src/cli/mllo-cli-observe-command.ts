import { writeCliLine, type MlloCliIo } from "./mllo-cli-io";
import type { MlloCliParsedArgs } from "./mllo-cli-types";

export type MlloCliObserveCommandArgs = {
  parsed: MlloCliParsedArgs;
  io: MlloCliIo;
  signal: AbortSignal;
};

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), {
      once: true,
    });
  });
}

type ExternalTraceLangfuseExportLoop = {
  close: () => Promise<void>;
};

function startExternalTraceLangfuseExportLoop(args: {
  parsed: MlloCliParsedArgs;
  io: MlloCliIo;
}): ExternalTraceLangfuseExportLoop | undefined {
  if (!args.parsed.langfuseExportExternalTraces) {
    return undefined;
  }
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let closed = false;
  let disabledReported = false;
  const runOnce = async (): Promise<void> => {
    if (running !== undefined) {
      return running;
    }
    running = import("../observer")
      .then(({ exportMlloExternalTraceLogsToLangfuse }) =>
        exportMlloExternalTraceLogsToLangfuse({
          homePath: args.parsed.homePath,
        }),
      )
      .then((result) => {
        if (result.exported > 0 || result.failed > 0) {
          writeCliLine(
            args.io.stdout,
            `Langfuse external traces: exported=${result.exported} skipped=${result.skipped} failed=${result.failed}`,
          );
        }
        if (result.disabled) {
          if (!disabledReported) {
            disabledReported = true;
            writeCliLine(
              args.io.stderr,
              "Langfuse external trace export is disabled: missing LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY.",
            );
          }
        }
      })
      .catch((error: unknown) => {
        writeCliLine(args.io.stderr, `Langfuse external trace export failed: ${String(error)}`);
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const intervalMs = args.parsed.langfuseExportIntervalMs ?? 2000;
  void runOnce();
  timer = setInterval(() => {
    if (!closed) {
      void runOnce();
    }
  }, intervalMs);
  return {
    close: async () => {
      closed = true;
      if (timer !== undefined) {
        clearInterval(timer);
      }
      await running;
    },
  };
}

export async function runMlloCliObserve(args: MlloCliObserveCommandArgs): Promise<number> {
  const { startMlloAnthropicTraceProxy, startMlloObserverServer, startMlloOpenAITraceProxy } =
    await import("../observer");
  const observer = await startMlloObserverServer({
    homePath: args.parsed.homePath,
    host: args.parsed.observerHost,
    port: args.parsed.observerPort,
  });
  const traceProxy = args.parsed.anthropicTraceProxy
    ? await startMlloAnthropicTraceProxy({
        homePath: args.parsed.homePath,
        host: args.parsed.traceProxyHost,
        port: args.parsed.traceProxyPort,
        source: args.parsed.anthropicTraceSource,
        upstreamBaseUrl: args.parsed.anthropicTraceUpstream,
        captureBodies: args.parsed.traceCaptureBodies,
      })
    : undefined;
  const openaiTraceProxy = args.parsed.openaiTraceProxy
    ? await startMlloOpenAITraceProxy({
        homePath: args.parsed.homePath,
        host: args.parsed.openaiTraceProxyHost,
        port: args.parsed.openaiTraceProxyPort,
        source: args.parsed.openaiTraceSource,
        upstreamBaseUrl: args.parsed.openaiTraceUpstream,
        captureBodies: args.parsed.traceCaptureBodies,
      })
    : undefined;
  const langfuseExportLoop = startExternalTraceLangfuseExportLoop(args);
  writeCliLine(args.io.stdout, `mllo observer: ${observer.url}`);
  if (traceProxy !== undefined) {
    writeCliLine(args.io.stdout, `mllo Anthropic trace proxy: ${traceProxy.url}`);
    writeCliLine(args.io.stdout, `upstream: ${traceProxy.upstreamBaseUrl}`);
    writeCliLine(args.io.stdout, `export ANTHROPIC_BASE_URL=${traceProxy.url}`);
  }
  if (openaiTraceProxy !== undefined) {
    writeCliLine(args.io.stdout, `mllo OpenAI trace proxy: ${openaiTraceProxy.url}`);
    writeCliLine(args.io.stdout, `upstream: ${openaiTraceProxy.upstreamBaseUrl}`);
    writeCliLine(args.io.stdout, `export OPENAI_BASE_URL=${openaiTraceProxy.url}/v1`);
  }
  if (langfuseExportLoop !== undefined) {
    writeCliLine(args.io.stdout, "Langfuse external trace export: enabled");
  }
  writeCliLine(args.io.stdout, "Press Ctrl+C to stop.");
  await waitForAbort(args.signal);
  await langfuseExportLoop?.close();
  await openaiTraceProxy?.close();
  await traceProxy?.close();
  await observer.close();
  writeCliLine(args.io.stdout, "mllo observer stopped.");
  return 0;
}
