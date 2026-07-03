import type {
  AgentCoreToolCall,
  AgentCoreToolExecutionResult,
} from "../tools/agent-core-tool-types";

export type PreExecutedToolCall = {
  call: AgentCoreToolCall;
  execution: Promise<AgentCoreToolExecutionResult>;
  abort: () => void;
};

export function createPreExecutedToolSignal(parentSignal?: AbortSignal): {
  signal: AbortSignal;
  abort: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let cleaned = false;
  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted === true) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, {
      once: true,
    });
  }
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    parentSignal?.removeEventListener("abort", abortFromParent);
  };
  return {
    signal: controller.signal,
    abort: () => {
      controller.abort();
      cleanup();
    },
    cleanup,
  };
}

export async function settlePreExecutedToolCall(preExecuted: PreExecutedToolCall): Promise<void> {
  preExecuted.abort();
  await Promise.allSettled([preExecuted.execution]);
}

export async function settlePreExecutedToolCalls(
  preExecutedToolCalls: Map<string, PreExecutedToolCall>,
): Promise<void> {
  await Promise.allSettled(
    [...preExecutedToolCalls.values()].map((preExecuted) => settlePreExecutedToolCall(preExecuted)),
  );
}
