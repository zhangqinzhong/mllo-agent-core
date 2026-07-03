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
  const { startMlloObserverServer } = await import("../observer");
  const observer = await startMlloObserverServer({
    homePath: args.parsed.homePath,
    host: args.parsed.observerHost,
    port: args.parsed.observerPort,
  });
  writeCliLine(args.io.stdout, `mllo observer: ${observer.url}`);
  writeCliLine(args.io.stdout, "Press Ctrl+C to stop.");
  await waitForAbort(args.signal);
  await observer.close();
  writeCliLine(args.io.stdout, "mllo observer stopped.");
  return 0;
}
