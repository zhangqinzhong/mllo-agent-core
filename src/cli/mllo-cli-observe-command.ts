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
        upstreamBaseUrl: args.parsed.anthropicTraceUpstream,
        captureBodies: args.parsed.traceCaptureBodies,
      })
    : undefined;
  const openaiTraceProxy = args.parsed.openaiTraceProxy
    ? await startMlloOpenAITraceProxy({
        homePath: args.parsed.homePath,
        host: args.parsed.openaiTraceProxyHost,
        port: args.parsed.openaiTraceProxyPort,
        upstreamBaseUrl: args.parsed.openaiTraceUpstream,
        captureBodies: args.parsed.traceCaptureBodies,
      })
    : undefined;
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
  writeCliLine(args.io.stdout, "Press Ctrl+C to stop.");
  await waitForAbort(args.signal);
  await openaiTraceProxy?.close();
  await traceProxy?.close();
  await observer.close();
  writeCliLine(args.io.stdout, "mllo observer stopped.");
  return 0;
}
