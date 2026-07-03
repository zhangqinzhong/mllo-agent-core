import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
  AgentCoreWorker,
  AgentCoreWorkerResult,
} from "../../agent-core/workers/agent-core-worker-types";
import {
  checkCodexCliCommandAvailability,
  type CodexCliAvailabilityCheck,
} from "./codex-cli-command-availability";
import { consumeCodexCliJsonLines, finishCodexCliBufferedJsonLine } from "./codex-cli-jsonl-events";

type CodexCliChildProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: (
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) => void;
  on: (event: "error", listener: (error: Error) => void) => void;
};

type CodexCliSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => CodexCliChildProcess;

export type CodexCliWorkerOptions = {
  availabilityCheck?: CodexCliAvailabilityCheck;
  command?: string;
  spawnImpl?: CodexCliSpawn;
};

const DEFAULT_CODEX_COMMAND = process.platform === "win32" ? "codex.cmd" : "codex";
const CODEX_WORKER_PERMISSION_REQUEST_ID = "codex-cli-workspace-write";

function defaultSpawn(
  command: string,
  args: string[],
  options: Parameters<CodexCliSpawn>[2],
): CodexCliChildProcess {
  return spawn(command, args, options) as CodexCliChildProcess;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestCodexCliRunPermission(args: {
  command: string;
  request: Parameters<AgentCoreWorker["run"]>[0];
}): Promise<boolean> {
  if (args.request.requestPermission === undefined) {
    args.request.onEvent?.({
      type: "worker-error",
      workerId: "codex-cli",
      message: "Codex CLI worker needs mllo permission bridge before spawning.",
    });
    return false;
  }
  const decision = await args.request.requestPermission({
    requestId: CODEX_WORKER_PERMISSION_REQUEST_ID,
    toolName: "codex_exec",
    capability: "shell-write",
    reason: "Codex CLI will run with workspace-write sandbox in this project.",
    input: {
      command: args.command,
      cwd: args.request.cwd,
      sandbox: "workspace-write",
    },
  });
  if (decision.status === "allow") {
    return true;
  }
  args.request.onEvent?.({
    type: "worker-error",
    workerId: "codex-cli",
    message: `Codex CLI permission denied: ${decision.reason}`,
  });
  return false;
}

// Codex CLI 是下级 agent，通过 exec JSONL 输出接入 mllo worker timeline。
export function createCodexCliWorker(options: CodexCliWorkerOptions = {}): AgentCoreWorker {
  const command = options.command ?? process.env.MLLO_CODEX_CLI_COMMAND ?? DEFAULT_CODEX_COMMAND;
  const spawnImpl = options.spawnImpl ?? defaultSpawn;

  return {
    id: "codex-cli",
    label: "Codex",
    description: "Delegate a scoped coding task to Codex CLI and return its final transcript.",
    capabilities: ["planning", "review", "file-read", "workspace-write", "shell", "network"],
    availability: {
      ttlMs: 60_000,
      failureGraceMs: 5 * 60_000,
      check: () =>
        (options.availabilityCheck ?? checkCodexCliCommandAvailability)({
          command,
        }),
    },
    async run(request) {
      request.onEvent?.({
        type: "worker-start",
        workerId: "codex-cli",
        label: "Codex",
      });
      if (
        !(await requestCodexCliRunPermission({
          command,
          request,
        }))
      ) {
        const content = "Codex CLI worker did not start because permission was denied.";
        request.onEvent?.({
          type: "worker-done",
          workerId: "codex-cli",
          content,
        });
        return {
          content,
          status: "denied",
        };
      }
      const child = spawnImpl(
        command,
        [
          "exec",
          "--json",
          "--color",
          "never",
          "--cd",
          request.cwd,
          "--sandbox",
          "workspace-write",
          "--config",
          'approval_policy="never"',
          "-",
        ],
        {
          cwd: request.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const parts: string[] = [];
      const stderrParts: string[] = [];
      let stdoutBuffer = "";
      let stdoutProcessing = Promise.resolve();
      let toolPermissionSequence = 0;
      let toolInvocationSequence = 0;
      let activeShellInvocationId: string | undefined;
      let stoppedByInternalPermission = false;
      let settled = false;

      const stopForInternalPermission = (): void => {
        if (stoppedByInternalPermission) {
          return;
        }
        stoppedByInternalPermission = true;
        queueMicrotask(() => {
          child.kill("SIGTERM");
        });
      };

      const abortListener = (): void => {
        child.kill("SIGTERM");
      };
      request.signal?.addEventListener("abort", abortListener, {
        once: true,
      });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutProcessing = stdoutProcessing.then(async () => {
          const result = await consumeCodexCliJsonLines({
            chunk,
            buffer: stdoutBuffer,
            parts,
            onEvent: request.onEvent,
            permissionSequence: toolPermissionSequence,
            toolInvocationSequence,
            ...(activeShellInvocationId === undefined ? {} : { activeShellInvocationId }),
            onPermissionRequest: request.requestPermission,
          });
          stdoutBuffer = result.buffer;
          toolPermissionSequence = result.permissionSequence;
          toolInvocationSequence = result.toolInvocationSequence;
          activeShellInvocationId = result.activeShellInvocationId;
          if (!result.allowed) {
            stopForInternalPermission();
          }
        });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrParts.push(chunk.toString("utf8"));
      });
      // prompt 走 stdin，避免 shell quoting 把长任务描述或中文内容弄坏。
      child.stdin.write(request.prompt);
      child.stdin.end();

      return await new Promise<AgentCoreWorkerResult>((resolve, reject) => {
        child.on("error", (error) => {
          if (settled) {
            return;
          }
          settled = true;
          request.signal?.removeEventListener("abort", abortListener);
          request.onEvent?.({
            type: "worker-error",
            workerId: "codex-cli",
            message: errorMessage(error),
          });
          reject(error);
        });
        child.once("close", async (code, signal) => {
          if (settled) {
            return;
          }
          settled = true;
          request.signal?.removeEventListener("abort", abortListener);
          try {
            await stdoutProcessing;
            const finishResult = await finishCodexCliBufferedJsonLine({
              buffer: stdoutBuffer,
              parts,
              onEvent: request.onEvent,
              permissionSequence: toolPermissionSequence,
              toolInvocationSequence,
              ...(activeShellInvocationId === undefined ? {} : { activeShellInvocationId }),
              onPermissionRequest: request.requestPermission,
            });
            toolPermissionSequence = finishResult.permissionSequence;
            toolInvocationSequence = finishResult.toolInvocationSequence;
            activeShellInvocationId = finishResult.activeShellInvocationId;
            if (!finishResult.allowed) {
              stoppedByInternalPermission = true;
            }
          } catch (error) {
            request.onEvent?.({
              type: "worker-error",
              workerId: "codex-cli",
              message: errorMessage(error),
            });
            reject(error);
            return;
          }
          if (stoppedByInternalPermission) {
            const content =
              "Codex CLI worker stopped because mllo denied internal tool permission.";
            request.onEvent?.({
              type: "worker-done",
              workerId: "codex-cli",
              content,
            });
            resolve({
              content,
              status: "denied",
            });
            return;
          }
          if (code !== 0) {
            const message =
              stderrParts.join("").trim() || `Codex worker exited with code ${code ?? signal}.`;
            request.onEvent?.({
              type: "worker-error",
              workerId: "codex-cli",
              message,
            });
            reject(new Error(message));
            return;
          }
          const content =
            parts.length === 0 ? "Codex worker completed without text output." : parts.join("\n\n");
          request.onEvent?.({
            type: "worker-done",
            workerId: "codex-cli",
            content,
          });
          resolve({
            content,
          });
        });
      });
    },
  };
}
