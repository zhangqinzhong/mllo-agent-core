import { spawn } from "node:child_process";
import type { AgentCoreWorkerAvailabilityCheckResult } from "../../agent-core/workers/agent-core-worker-types";

export type CodexCliAvailabilityCheck = (args: {
  command: string;
}) => Promise<AgentCoreWorkerAvailabilityCheckResult> | AgentCoreWorkerAvailabilityCheckResult;

// 用轻量 --version 探测 CLI 是否存在，避免模型看到无法启动的 worker。
export async function checkCodexCliCommandAvailability(args: {
  command: string;
}): Promise<AgentCoreWorkerAvailabilityCheckResult> {
  return await new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(args.command, ["--version"], {
      stdio: "ignore",
    });
    const finish = (result: AgentCoreWorkerAvailabilityCheckResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolve(result);
    };
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        available: false,
        reason: `Codex CLI availability check timed out: ${args.command} --version`,
      });
    }, 3_000);
    timeout.unref();
    child.once("error", (error) => {
      finish({
        available: false,
        reason: `Codex CLI command is not available: ${args.command}. ${error.message}`,
      });
    });
    child.once("close", (code) => {
      finish(
        code === 0
          ? {
              available: true,
              reason: `Codex CLI command is available: ${args.command}.`,
            }
          : {
              available: false,
              reason: `Codex CLI availability check failed with code ${code}: ${args.command} --version`,
            },
      );
    });
  });
}
