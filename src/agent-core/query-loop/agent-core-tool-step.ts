import { runAgentCoreHooks } from "../hooks/agent-core-hook-runner";
import { appendMissingToolResults } from "./agent-core-tool-result-pairing";
import {
  createAgentCoreDuplicateToolCallTracker,
  hasAgentCoreDuplicateToolCall,
  markAgentCoreDuplicateToolCall,
  type AgentCoreDuplicateToolCallTracker,
} from "./agent-core-duplicate-tool-call";
import { runExecutableAgentCoreToolCallsStep } from "./agent-core-executable-tool-calls-step";
import { createAgentCoreRepeatedToolFailureResult } from "./agent-core-repeated-tool-failure";
import {
  createAgentCoreToolBatchSummary,
  type AgentCoreToolBatchCompletedItem,
} from "./agent-core-tool-batch-summary";
import { createAgentCoreToolFailureFeedback } from "./agent-core-tool-failure-feedback";
import {
  applyAgentCoreToolResultTurnBudget,
  createAgentCoreToolResultTurnBudget,
  type AgentCoreToolResultTurnBudget,
} from "./agent-core-tool-result-turn-budget";
import type {
  AgentCoreToolCall,
  AgentCoreToolExecutionResult,
  AgentCoreToolResult,
} from "../tools/agent-core-tool-types";
import {
  settlePreExecutedToolCall,
  type PreExecutedToolCall,
} from "./agent-core-pre-executed-tool-call";
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult,
} from "./agent-core-query-types";
import type { AgentCoreMiddlewareChain } from "../middleware/agent-core-middleware-chain";

// 把工具执行结果转换成模型能继续消费的 tool 消息。
function appendToolMessage(
  messages: AgentCoreMessage[],
  call: AgentCoreToolCall,
  result: AgentCoreToolResult,
): AgentCoreMessage {
  const message: AgentCoreMessage = {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: result.content,
    isError: result.isError,
    ...(result.errorKind === undefined ? {} : { errorKind: result.errorKind }),
    ...(result.outputTruncated === undefined ? {} : { outputTruncated: result.outputTruncated }),
    ...(result.outputOriginalChars === undefined
      ? {}
      : { outputOriginalChars: result.outputOriginalChars }),
    ...(result.outputMaxChars === undefined ? {} : { outputMaxChars: result.outputMaxChars }),
    ...(result.outputBlobPath === undefined ? {} : { outputBlobPath: result.outputBlobPath }),
    ...(result.outputBlobBytes === undefined ? {} : { outputBlobBytes: result.outputBlobBytes }),
  };
  messages.push(message);
  return message;
}

// 把未注册工具转换成普通工具错误。模型看到 tool_result 后才能自己修正工具名。
function toolExecutionResultContent(
  call: AgentCoreToolCall,
  execution: AgentCoreToolExecutionResult,
): AgentCoreToolResult {
  switch (execution.status) {
    case "ok":
      return createAgentCoreToolFailureFeedback({
        call,
        result: execution.result,
      });
    case "not-found":
      return createAgentCoreToolFailureFeedback({
        call,
        result: {
          content: execution.message,
          isError: true,
          errorKind: "unknown-tool",
        },
      });
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

// 检测 ask_user 这类需要用户输入的结果；它必须暂停 query loop，而不是写成普通 tool_result。
function elicitationFromExecution(
  execution: AgentCoreToolExecutionResult,
): AgentCoreToolResult["elicitation"] {
  return execution.status === "ok" ? execution.result.elicitation : undefined;
}

// 把重复失败 guard 转成普通工具执行结果。query loop 后续仍按 tool_result 闭环处理。
function repeatedToolFailureExecution(
  messages: readonly AgentCoreMessage[],
  call: AgentCoreToolCall,
): AgentCoreToolExecutionResult | undefined {
  const result = createAgentCoreRepeatedToolFailureResult({
    messages,
    call,
  });
  return result === undefined
    ? undefined
    : {
        status: "ok",
        result,
      };
}

// 生成无需真实执行的工具结果。先挡同轮重复，再挡跨轮原样重复失败。
function syntheticToolExecution(args: {
  duplicateTracker: AgentCoreDuplicateToolCallTracker;
  messages: readonly AgentCoreMessage[];
  call: AgentCoreToolCall;
}): AgentCoreToolExecutionResult | undefined {
  const duplicate = markAgentCoreDuplicateToolCall({
    tracker: args.duplicateTracker,
    call: args.call,
  });
  if (duplicate !== undefined) {
    return duplicate;
  }
  return repeatedToolFailureExecution(args.messages, args.call);
}

// 处理工具完成事件。权限暂停/拒绝会返回终态，普通结果会回灌给下一轮模型。
async function* handleToolCompletion(args: {
  queryArgs: AgentCoreQueryLoopArgs;
  messages: AgentCoreMessage[];
  call: AgentCoreToolCall;
  execution: AgentCoreToolExecutionResult;
  middlewareChain: AgentCoreMiddlewareChain;
  resultBudget: AgentCoreToolResultTurnBudget;
  completedItems: AgentCoreToolBatchCompletedItem[];
  remainingCalls?: readonly AgentCoreToolCall[];
}): AsyncGenerator<AgentCoreQueryEvent, AgentCoreQueryLoopResult | null> {
  const remainingCalls = args.remainingCalls ?? [];
  const { call, execution, messages, queryArgs } = args;

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
    };
  }

  if (execution.status === "permission-denied") {
    const result = await applyAgentCoreToolResultTurnBudget({
      budget: args.resultBudget,
      call,
      storeToolResultBlob: queryArgs.storeToolResultBlob,
      result: {
        content: execution.decision.reason,
        isError: true,
        errorKind: "permission-denied",
      },
    });
    appendToolMessage(messages, call, result);
    args.completedItems.push({
      call,
      result,
    });
    yield {
      type: "permission-denied",
      call,
      decision: execution.decision,
    };
    yield {
      type: "tool-result",
      call,
      result,
    };
    return {
      status: "denied",
      messages,
      call,
      decision: execution.decision,
    };
  }

  const elicitation = elicitationFromExecution(execution);
  if (elicitation !== undefined) {
    const hookDecision = yield* runAgentCoreHooks({
      hooks: queryArgs.hooks ?? [],
      context: {
        phase: "elicitation",
        cwd: queryArgs.cwd,
        call,
        elicitationRequest: elicitation,
        signal: queryArgs.signal,
      },
    });
    if (hookDecision.action === "block") {
      const message = hookDecision.reason ?? "Elicitation hook blocked ask_user.";
      yield {
        type: "error",
        message,
      };
      return {
        status: "error",
        messages,
        message,
      };
    }
    yield* appendMissingToolResults(
      messages,
      remainingCalls,
      "Skipped because ask_user paused for user input. Ask one question at a time and continue after the user answers.",
    );
    yield {
      type: "elicitation-required",
      call,
      request: elicitation,
    };
    return {
      status: "waiting-for-elicitation",
      messages,
      call,
      request: elicitation,
    };
  }

  const result = await applyAgentCoreToolResultTurnBudget({
    budget: args.resultBudget,
    call,
    maxResultSizeChars: execution.status === "ok" ? execution.maxResultSizeChars : undefined,
    storeToolResultBlob: queryArgs.storeToolResultBlob,
    result: toolExecutionResultContent(call, execution),
  });
  appendToolMessage(messages, call, result);
  args.completedItems.push({
    call,
    result,
  });
  await args.middlewareChain.afterTool({
    queryArgs,
    messages,
    call,
    execution,
    result,
  });
  yield {
    type: "tool-result",
    call,
    result,
  };
  return null;
}

async function* maybeYieldToolBatchSummary(args: {
  queryArgs: AgentCoreQueryLoopArgs;
  turn: number;
  completedItems: readonly AgentCoreToolBatchCompletedItem[];
  lastAssistantText?: string;
}): AsyncGenerator<AgentCoreQueryEvent> {
  const summary = await createAgentCoreToolBatchSummary({
    completedItems: args.completedItems,
    model: args.queryArgs.toolSummaryModel ?? args.queryArgs.model,
    signal: args.queryArgs.signal,
    lastAssistantText: args.lastAssistantText,
  });
  if (summary === undefined) {
    return;
  }
  yield {
    type: "tool-batch-summary",
    turn: args.turn,
    summary,
  };
}

// 运行一组工具调用。编排层负责并发/串行，query loop 只处理事件和终态。
export async function* runToolCallsStep(args: {
  queryArgs: AgentCoreQueryLoopArgs;
  messages: AgentCoreMessage[];
  calls: readonly AgentCoreToolCall[];
  preExecutedToolCalls: Map<string, PreExecutedToolCall>;
  middlewareChain: AgentCoreMiddlewareChain;
  turn: number;
}): AsyncGenerator<AgentCoreQueryEvent, AgentCoreQueryLoopResult | null> {
  const duplicateTracker = createAgentCoreDuplicateToolCallTracker();
  const resultBudget = createAgentCoreToolResultTurnBudget();
  const completedItems: AgentCoreToolBatchCompletedItem[] = [];
  const lastAssistantText = [...args.messages]
    .reverse()
    .find((message) => message.role === "assistant")?.content;
  const remainingCallsAfter = (call: AgentCoreToolCall): readonly AgentCoreToolCall[] => {
    const index = args.calls.findIndex((candidate) => candidate.id === call.id);
    return index >= 0 ? args.calls.slice(index + 1) : [];
  };
  const onToolComplete = (input: {
    call: AgentCoreToolCall;
    execution: AgentCoreToolExecutionResult;
    remainingCalls?: readonly AgentCoreToolCall[];
  }) =>
    handleToolCompletion({
      queryArgs: args.queryArgs,
      messages: args.messages,
      call: input.call,
      execution: input.execution,
      middlewareChain: args.middlewareChain,
      resultBudget,
      completedItems,
      remainingCalls: input.remainingCalls,
    });

  for (const call of args.calls.filter((item) => args.preExecutedToolCalls.has(item.id))) {
    const preExecuted = args.preExecutedToolCalls.get(call.id);
    if (preExecuted === undefined) {
      continue;
    }
    const syntheticExecution = syntheticToolExecution({
      duplicateTracker,
      messages: args.messages,
      call,
    });
    if (syntheticExecution !== undefined) {
      await settlePreExecutedToolCall(preExecuted);
    }
    const result = yield* handleToolCompletion({
      queryArgs: args.queryArgs,
      messages: args.messages,
      call,
      execution: syntheticExecution ?? (await preExecuted.execution),
      middlewareChain: args.middlewareChain,
      resultBudget,
      completedItems,
      remainingCalls: remainingCallsAfter(call),
    });
    if (result !== null) {
      yield* maybeYieldToolBatchSummary({
        queryArgs: args.queryArgs,
        turn: args.turn,
        completedItems,
        lastAssistantText,
      });
      return result;
    }
  }

  const remainingCalls = args.calls.filter((call) => !args.preExecutedToolCalls.has(call.id));
  if (
    !hasAgentCoreDuplicateToolCall({
      tracker: duplicateTracker,
      calls: remainingCalls,
    }) &&
    !remainingCalls.some((call) => repeatedToolFailureExecution(args.messages, call) !== undefined)
  ) {
    const result = yield* runExecutableAgentCoreToolCallsStep({
      queryArgs: args.queryArgs,
      messages: args.messages,
      calls: remainingCalls,
      middlewareChain: args.middlewareChain,
      remainingCallsAfter,
      onToolComplete,
    });
    yield* maybeYieldToolBatchSummary({
      queryArgs: args.queryArgs,
      turn: args.turn,
      completedItems,
      lastAssistantText,
    });
    return result;
  }

  for (const call of remainingCalls) {
    const syntheticExecution = syntheticToolExecution({
      duplicateTracker,
      messages: args.messages,
      call,
    });
    if (syntheticExecution !== undefined) {
      yield {
        type: "tool-call",
        call,
      };
      const result = yield* handleToolCompletion({
        queryArgs: args.queryArgs,
        messages: args.messages,
        call,
        execution: syntheticExecution,
        middlewareChain: args.middlewareChain,
        resultBudget,
        completedItems,
        remainingCalls: remainingCallsAfter(call),
      });
      if (result !== null) {
        yield* maybeYieldToolBatchSummary({
          queryArgs: args.queryArgs,
          turn: args.turn,
          completedItems,
          lastAssistantText,
        });
        return result;
      }
      continue;
    }
    const result = yield* runExecutableAgentCoreToolCallsStep({
      queryArgs: args.queryArgs,
      messages: args.messages,
      calls: [call],
      middlewareChain: args.middlewareChain,
      remainingCallsAfter,
      onToolComplete,
    });
    if (result !== null) {
      yield* maybeYieldToolBatchSummary({
        queryArgs: args.queryArgs,
        turn: args.turn,
        completedItems,
        lastAssistantText,
      });
      return result;
    }
  }

  yield* maybeYieldToolBatchSummary({
    queryArgs: args.queryArgs,
    turn: args.turn,
    completedItems,
    lastAssistantText,
  });
  return null;
}
