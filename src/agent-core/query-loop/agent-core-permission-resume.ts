import { runAgentCoreToolCalls } from "../tools/agent-core-tool-orchestration";
import {
  startRunningAgentCoreTool,
  waitForRunningAgentCoreToolComplete,
  waitForRunningAgentCoreToolProgress,
} from "../tools/agent-core-running-tool";
import type {
  AgentCoreToolCall,
  AgentCoreToolDefinition,
  AgentCoreToolExecutionResult,
  AgentCoreToolResult,
} from "../tools/agent-core-tool-types";
import {
  applyAgentCoreToolResultTurnBudget,
  createAgentCoreToolResultTurnBudget,
  type AgentCoreToolResultTurnBudget,
} from "./agent-core-tool-result-turn-budget";
import type { AgentCoreHookDefinition } from "../hooks/agent-core-hook-types";
import type {
  AgentCoreMessage,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopResult,
} from "./agent-core-query-types";
import { appendMissingToolResults } from "./agent-core-tool-result-pairing";

export type AgentCorePermissionResumeDecision =
  | {
      status: "allow";
    }
  | {
      status: "deny";
      reason: string;
    };

export type AgentCorePermissionResumeArgs = {
  waitingResult: Extract<AgentCoreQueryLoopResult, { status: "waiting-for-permission" }>;
  cwd: string;
  tools: readonly AgentCoreToolDefinition[];
  hooks?: readonly AgentCoreHookDefinition[];
  decision: AgentCorePermissionResumeDecision;
  signal?: AbortSignal;
  requestWorkerPermission?: AgentCoreQueryLoopArgs["requestWorkerPermission"];
};

export type AgentCorePermissionResumeResult =
  | {
      status: "resumed";
      messages: AgentCoreMessage[];
      resumedCall: AgentCoreToolCall;
    }
  | (Extract<
      AgentCoreQueryLoopResult,
      {
        status: "waiting-for-permission" | "denied";
      }
    > & {
      resumedCall: AgentCoreToolCall;
    });

type AgentCorePermissionResumePauseResult = Extract<
  AgentCorePermissionResumeResult,
  {
    status: "waiting-for-permission" | "denied";
  }
>;

// 找到最后一个带 toolCalls 的 assistant 消息。权限恢复只处理当前悬停的 assistant turn。
function lastAssistantToolCalls(messages: readonly AgentCoreMessage[]): AgentCoreToolCall[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      return message.toolCalls ?? [];
    }
  }
  return [];
}

function latestAssistantMessageIndex(messages: readonly AgentCoreMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return index;
    }
  }
  return -1;
}

function createPermissionResumeResultBudget(
  messages: readonly AgentCoreMessage[],
): AgentCoreToolResultTurnBudget {
  const budget = createAgentCoreToolResultTurnBudget();
  const assistantIndex = latestAssistantMessageIndex(messages);
  for (const message of messages.slice(assistantIndex + 1)) {
    if (message.role === "tool") {
      budget.usedChars += message.content.length;
    }
  }
  return budget;
}

// 找到当前 permission call 及其后续同轮工具。前面的工具在暂停前已经完成或不应重跑。
function callsFromPermissionPoint(
  calls: readonly AgentCoreToolCall[],
  call: AgentCoreToolCall,
): AgentCoreToolCall[] {
  const index = calls.findIndex((candidate) => candidate.id === call.id);
  return index >= 0 ? calls.slice(index) : [call];
}

// 把工具执行状态转换为 queryLoop 消息可消费的 tool result。
function toolResultFromExecution(execution: AgentCoreToolExecutionResult): AgentCoreToolResult {
  switch (execution.status) {
    case "ok":
      return execution.result;
    case "not-found":
      return {
        content: execution.message,
        isError: true,
        errorKind: "unknown-tool",
      };
    case "permission-required":
      return {
        content: execution.decision.reason,
        isError: true,
        errorKind: "tool-error",
      };
    case "permission-denied":
      return {
        content: execution.decision.reason,
        isError: true,
        errorKind: "permission-denied",
      };
  }
}

// 追加一个 tool message，并同步产出 timeline 事件。
function* appendToolResult(
  messages: AgentCoreMessage[],
  call: AgentCoreToolCall,
  result: AgentCoreToolResult,
  resultBudget: AgentCoreToolResultTurnBudget,
): Generator<AgentCoreQueryEvent, void> {
  const budgetedResult = applyAgentCoreToolResultTurnBudget({
    budget: resultBudget,
    call,
    result,
  });
  messages.push({
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: budgetedResult.content,
    isError: budgetedResult.isError,
    ...(budgetedResult.errorKind === undefined ? {} : { errorKind: budgetedResult.errorKind }),
    ...(budgetedResult.outputTruncated === undefined
      ? {}
      : { outputTruncated: budgetedResult.outputTruncated }),
    ...(budgetedResult.outputOriginalChars === undefined
      ? {}
      : { outputOriginalChars: budgetedResult.outputOriginalChars }),
    ...(budgetedResult.outputMaxChars === undefined
      ? {}
      : { outputMaxChars: budgetedResult.outputMaxChars }),
    ...(budgetedResult.outputBlobPath === undefined
      ? {}
      : { outputBlobPath: budgetedResult.outputBlobPath }),
    ...(budgetedResult.outputBlobBytes === undefined
      ? {}
      : { outputBlobBytes: budgetedResult.outputBlobBytes }),
  });
  yield {
    type: "tool-result",
    call,
    result: budgetedResult,
  };
}

// 用户拒绝权限时写入明确的 tool_result，并跳过同一轮剩余工具以保持协议完整。
function* denyPermissionResume(
  messages: AgentCoreMessage[],
  calls: readonly AgentCoreToolCall[],
  decision: Extract<AgentCorePermissionResumeDecision, { status: "deny" }>,
  resultBudget: AgentCoreToolResultTurnBudget,
): Generator<AgentCoreQueryEvent, void> {
  const [call, ...remainingCalls] = calls;
  if (call === undefined) {
    return;
  }

  yield* appendToolResult(
    messages,
    call,
    {
      content: `Permission denied by user: ${decision.reason}`,
      isError: true,
      errorKind: "permission-denied",
    },
    resultBudget,
  );
  yield* appendMissingToolResults(
    messages,
    remainingCalls,
    "Skipped because a previous tool permission was denied by the user.",
  );
}

function* appendPermissionDeniedResult(
  messages: AgentCoreMessage[],
  call: AgentCoreToolCall,
  execution: Extract<AgentCoreToolExecutionResult, { status: "permission-denied" }>,
  resultBudget: AgentCoreToolResultTurnBudget,
): Generator<AgentCoreQueryEvent, void> {
  const result = toolResultFromExecution(execution);
  yield {
    type: "permission-denied",
    call,
    decision: execution.decision,
  };
  yield* appendToolResult(messages, call, result, resultBudget);
}

// 用户允许权限时执行当前工具，并继续处理同一 assistant turn 后续工具。
async function* allowPermissionResume(
  args: AgentCorePermissionResumeArgs,
  messages: AgentCoreMessage[],
  calls: readonly AgentCoreToolCall[],
  resultBudget: AgentCoreToolResultTurnBudget,
): AsyncGenerator<AgentCoreQueryEvent, AgentCorePermissionResumePauseResult | null> {
  const [call, ...remainingCalls] = calls;
  if (call === undefined) {
    return null;
  }

  const running = startRunningAgentCoreTool({
    call,
    cwd: args.cwd,
    signal: args.signal,
    tools: args.tools,
    permissionOverride: "allow",
    index: 0,
    requestWorkerPermission: args.requestWorkerPermission,
  });
  // complete waiter 只能创建一次；多个 waiter 会竞争 drain progress 队列，导致事件丢失。
  const completePromise = waitForRunningAgentCoreToolComplete(running);
  let execution;
  while (execution === undefined) {
    const update = await Promise.race([
      completePromise,
      waitForRunningAgentCoreToolProgress(running),
    ]);
    if (update.type === "progress") {
      yield {
        type: "tool-progress",
        call,
        progress: update.progress,
      };
      continue;
    }
    for (const progress of update.queuedProgress) {
      yield {
        type: "tool-progress",
        call,
        progress,
      };
    }
    execution = update.execution;
  }
  if (execution.status === "permission-required") {
    yield {
      type: "permission-required",
      call,
      decision: execution.decision,
    };
    return {
      status: "waiting-for-permission",
      messages,
      call,
      decision: execution.decision,
      resumedCall: args.waitingResult.call,
    };
  }
  if (execution.status === "permission-denied") {
    yield* appendPermissionDeniedResult(messages, call, execution, resultBudget);
    return {
      status: "denied",
      messages,
      call,
      decision: execution.decision,
      resumedCall: args.waitingResult.call,
    };
  }
  yield* appendToolResult(messages, call, toolResultFromExecution(execution), resultBudget);

  for await (const update of runAgentCoreToolCalls({
    calls: remainingCalls,
    cwd: args.cwd,
    hooks: args.hooks ?? [],
    signal: args.signal,
    tools: args.tools,
    requestWorkerPermission: args.requestWorkerPermission,
  })) {
    if (update.type === "hook-event") {
      yield update;
      continue;
    }
    if (update.type === "tool-start") {
      yield {
        type: "tool-call",
        call: update.call,
      };
      continue;
    }
    if (update.type === "tool-progress") {
      yield update;
      continue;
    }
    if (update.execution.status === "permission-required") {
      yield {
        type: "permission-required",
        call: update.call,
        decision: update.execution.decision,
      };
      return {
        status: "waiting-for-permission",
        messages,
        call: update.call,
        decision: update.execution.decision,
        resumedCall: args.waitingResult.call,
      };
    }
    if (update.execution.status === "permission-denied") {
      yield* appendPermissionDeniedResult(messages, update.call, update.execution, resultBudget);
      return {
        status: "denied",
        messages,
        call: update.call,
        decision: update.execution.decision,
        resumedCall: args.waitingResult.call,
      };
    }
    yield* appendToolResult(
      messages,
      update.call,
      toolResultFromExecution(update.execution),
      resultBudget,
    );
  }
  return null;
}

// 恢复 permission-required 状态；后续工具再次要权限时继续返回等待状态。
export async function* resumeAgentCorePermissionDecision(
  args: AgentCorePermissionResumeArgs,
): AsyncGenerator<AgentCoreQueryEvent, AgentCorePermissionResumeResult> {
  const messages = [...args.waitingResult.messages];
  const calls = callsFromPermissionPoint(lastAssistantToolCalls(messages), args.waitingResult.call);
  const resultBudget = createPermissionResumeResultBudget(messages);

  if (args.decision.status === "deny") {
    yield* denyPermissionResume(messages, calls, args.decision, resultBudget);
    return {
      status: "resumed",
      messages,
      resumedCall: args.waitingResult.call,
    };
  }

  const paused = yield* allowPermissionResume(args, messages, calls, resultBudget);
  if (paused !== null) {
    return paused;
  }

  return {
    status: "resumed",
    messages,
    resumedCall: args.waitingResult.call,
  };
}
