import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AgentCoreQueryLoopResult } from "../agent-core/query-loop/agent-core-query-types";
import type { AgentCoreRunControllerOptions } from "../agent-core/runtime/agent-core-run-controller-types";
import type {
  AgentCoreWorkerPermissionDecision,
  AgentCoreWorkerPermissionRequest,
} from "../agent-core/workers/agent-core-worker-types";
import { writeCliLine } from "./mllo-cli-io";

type PermissionResult = Extract<AgentCoreQueryLoopResult, { status: "waiting-for-permission" }>;

type ElicitationResult = Extract<AgentCoreQueryLoopResult, { status: "waiting-for-elicitation" }>;

export type MlloCliInteraction = {
  handlers: Pick<
    AgentCoreRunControllerOptions,
    "onPermissionRequest" | "onElicitationRequest" | "onWorkerPermissionRequest"
  >;
  question: (prompt: string) => Promise<string>;
  close: () => void;
};

export function createMlloCliReadline(args: {
  stdin: Readable;
  stderr: Writable;
  history?: string[];
  historySize?: number;
}): Interface {
  return createInterface({
    input: args.stdin,
    output: args.stderr,
    terminal: true,
    history: args.history,
    historySize: args.historySize,
    removeHistoryDuplicates: true,
  });
}

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase();
}

function isYes(answer: string): boolean {
  const normalized = normalizeAnswer(answer);
  return normalized === "y" || normalized === "yes";
}

async function askPermission(args: {
  readline: Interface | undefined;
  stderr: Writable;
  title: string;
  reason: string;
  input: unknown;
  interactive: boolean;
}): Promise<{ status: "allow" } | { status: "deny"; reason: string }> {
  writeCliLine(args.stderr, args.title);
  writeCliLine(args.stderr, `Reason: ${args.reason}`);
  writeCliLine(args.stderr, `Input: ${JSON.stringify(args.input, null, 2)}`);
  if (!args.interactive || args.readline === undefined) {
    return {
      status: "deny",
      reason: "mllo CLI non-interactive mode cannot confirm this permission.",
    };
  }
  const answer = await args.readline.question("Allow? [y/N] ");
  if (isYes(answer)) {
    return { status: "allow" };
  }
  return {
    status: "deny",
    reason: "Denied by CLI user.",
  };
}

async function askElicitation(args: {
  readline: Interface | undefined;
  stderr: Writable;
  result: ElicitationResult;
  interactive: boolean;
}): ReturnType<NonNullable<AgentCoreRunControllerOptions["onElicitationRequest"]>> {
  const request = args.result.request;
  writeCliLine(args.stderr, request.question);
  if (request.context !== undefined) {
    writeCliLine(args.stderr, request.context);
  }
  if (request.options !== undefined && request.options.length > 0) {
    request.options.forEach((option, index) => {
      writeCliLine(args.stderr, `  ${index + 1}. ${option}`);
    });
  }
  if (!args.interactive || args.readline === undefined) {
    return {
      status: "cancel",
      reason: "mllo CLI non-interactive mode cannot answer this question.",
    };
  }
  const answer = await args.readline.question("Answer: ");
  const trimmed = answer.trim();
  if (request.options !== undefined && request.options.length > 0) {
    const numericChoice = Number.parseInt(trimmed, 10);
    if (
      Number.isSafeInteger(numericChoice) &&
      numericChoice >= 1 &&
      numericChoice <= request.options.length
    ) {
      return {
        status: "answer",
        answer: request.options[numericChoice - 1]!,
      };
    }
  }
  if (trimmed.length === 0) {
    return {
      status: "cancel",
      reason: "CLI user submitted an empty answer.",
    };
  }
  return {
    status: "answer",
    answer: trimmed,
  };
}

export function createMlloCliInteraction(args: {
  readline?: Interface;
  stdin: Readable;
  stderr: Writable;
  interactive: boolean;
}): MlloCliInteraction {
  const readline =
    args.readline ??
    (args.interactive
      ? createMlloCliReadline({
          stdin: args.stdin,
          stderr: args.stderr,
        })
      : undefined);
  const ownsReadline = args.readline === undefined && readline !== undefined;
  return {
    handlers: {
      onPermissionRequest: async (result: PermissionResult) =>
        await askPermission({
          readline,
          stderr: args.stderr,
          title: `mllo wants to run ${result.call.name}.`,
          reason: result.decision.reason,
          input: result.call.input,
          interactive: args.interactive,
        }),
      onElicitationRequest: async (result: ElicitationResult) =>
        await askElicitation({
          readline,
          stderr: args.stderr,
          result,
          interactive: args.interactive,
        }),
      onWorkerPermissionRequest: async (
        request: AgentCoreWorkerPermissionRequest & { workerId: string },
      ): Promise<AgentCoreWorkerPermissionDecision> =>
        await askPermission({
          readline,
          stderr: args.stderr,
          title: `mllo worker ${request.workerId} wants ${request.toolName}.`,
          reason: request.reason,
          input: request.input,
          interactive: args.interactive,
        }),
    },
    question: async (prompt: string) => {
      if (readline === undefined) {
        throw new Error("mllo CLI readline is not available.");
      }
      return await readline.question(prompt);
    },
    close: () => {
      if (ownsReadline) {
        readline?.close();
      }
    },
  };
}
