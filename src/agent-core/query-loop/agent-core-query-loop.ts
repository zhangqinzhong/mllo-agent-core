import {
  classifyAgentCoreModelError,
  getAgentCoreModelErrorMessage,
} from "../model/agent-core-model-error-classification";
import { createAgentCoreMiddlewareChain } from "../middleware/agent-core-middleware-chain";
import { readAgentCoreModelTurn } from "./agent-core-model-turn";
import { settlePreExecutedToolCalls } from "./agent-core-pre-executed-tool-call";
import { appendMissingToolResults } from "./agent-core-tool-result-pairing";
import { runToolCallsStep } from "./agent-core-tool-step";
import {
  latestUserPrompt,
  lifecycleBlockedResult,
  runLifecycleHooksStep,
  runStopFailureHooksStep,
} from "./agent-core-lifecycle-hooks";
import {
  createStoppedAgentCoreQueryLoopResult,
  finishAgentCoreQueryLoopResult,
  isAgentCoreQueryStopped,
} from "./agent-core-query-loop-control";
import {
  agentCoreModelResponseHasToolCalls,
  appendAgentCoreAssistantMessage,
} from "./agent-core-query-loop-response";
import { runAgentCoreStopHooksStep } from "./agent-core-query-loop-stop-hooks";
import type {
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult,
} from "./agent-core-query-types";
import type { AgentCoreToolCall } from "../tools/agent-core-tool-types";

const DEFAULT_MAX_TURNS = 20;

// 运行 Agent Core 的核心 query loop。它负责模型-工具-模型的闭环，不直接绑定任何 UI。
export async function* runAgentCoreQueryLoop(
  args: AgentCoreQueryLoopArgs,
): AsyncGenerator<AgentCoreQueryEvent, AgentCoreQueryLoopResult> {
  const messages = [...args.messages];
  const middlewareChain = createAgentCoreMiddlewareChain(args.middlewares);
  let queryArgs = args;
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_TURNS;
  let pendingToolCalls: AgentCoreToolCall[] = [];
  const finish = (result: AgentCoreQueryLoopResult) =>
    finishAgentCoreQueryLoopResult({
      queryArgs,
      messages,
      middlewareChain,
      result,
    });

  try {
    const middlewareTools = await middlewareChain.collectTools({
      queryArgs,
      messages,
    });
    if (middlewareTools.length > 0) {
      queryArgs = {
        ...queryArgs,
        tools: [...(queryArgs.tools ?? []), ...middlewareTools],
      };
    }
    await middlewareChain.beforeAgent({
      queryArgs,
      messages,
    });

    const sessionStartDecision = yield* runLifecycleHooksStep({
      queryArgs,
      phase: "session-start",
    });
    if (sessionStartDecision.action === "block") {
      const result = lifecycleBlockedResult(messages, sessionStartDecision.reason);
      yield {
        type: "error",
        message: result.message,
      };
      return yield* finish(result);
    }

    const userPromptDecision = yield* runLifecycleHooksStep({
      queryArgs,
      phase: "user-prompt-submit",
      userPrompt: latestUserPrompt(messages),
    });
    if (userPromptDecision.action === "block") {
      const result = lifecycleBlockedResult(messages, userPromptDecision.reason);
      yield {
        type: "error",
        message: result.message,
      };
      return yield* finish(result);
    }

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (isAgentCoreQueryStopped(queryArgs.signal)) {
        const reason = "Agent run was stopped before the next model turn.";
        yield {
          type: "stopped",
          reason,
        };
        return yield* finish({
          status: "stopped",
          messages,
          reason,
        });
      }

      await middlewareChain.beforeModel({
        queryArgs,
        messages,
        turn,
      });

      yield {
        type: "turn-start",
        turn,
      };

      const modelTurn = yield* readAgentCoreModelTurn(queryArgs, messages);
      const { response, preExecutedToolCalls } = modelTurn;
      await middlewareChain.afterModel({
        queryArgs,
        messages,
        turn,
        response,
      });
      appendAgentCoreAssistantMessage(messages, response);
      pendingToolCalls = response.toolCalls ?? [];
      if (modelTurn.streamInterrupted !== undefined) {
        await settlePreExecutedToolCalls(preExecutedToolCalls);
        yield* appendMissingToolResults(
          messages,
          pendingToolCalls,
          modelTurn.streamInterrupted.message,
        );
        yield {
          type: "error",
          message: modelTurn.streamInterrupted.message,
        };
        return yield* finish({
          status: "error",
          messages,
          message: modelTurn.streamInterrupted.message,
          errorCode: classifyAgentCoreModelError(modelTurn.streamInterrupted.message),
        });
      }
      if (isAgentCoreQueryStopped(queryArgs.signal)) {
        const reason = "Agent run was stopped after the model turn.";
        await settlePreExecutedToolCalls(preExecutedToolCalls);
        yield* appendMissingToolResults(messages, pendingToolCalls, reason);
        yield {
          type: "stopped",
          reason,
        };
        return yield* finish(createStoppedAgentCoreQueryLoopResult(messages, reason));
      }

      if (response.content.length > 0) {
        yield {
          type: "assistant-message",
          content: response.content,
        };
      }

      const calls = response.toolCalls ?? [];
      if (!agentCoreModelResponseHasToolCalls(response)) {
        const hookDecision = yield* runAgentCoreStopHooksStep(queryArgs, response.content);
        if (hookDecision.failed === true) {
          yield* runStopFailureHooksStep({
            queryArgs,
            content: response.content,
            reason: hookDecision.reason,
          });
        }
        if (hookDecision.action === "request-continue") {
          continue;
        }
        if (hookDecision.action === "block") {
          const message = hookDecision.reason ?? "Stop hook blocked completion.";
          yield {
            type: "error",
            message,
          };
          return yield* finish({
            status: "error",
            messages,
            message,
          });
        }
        yield {
          type: "final",
          content: response.content,
        };
        return yield* finish({
          status: "completed",
          messages,
        });
      }

      if (isAgentCoreQueryStopped(queryArgs.signal)) {
        const reason = "Agent run was stopped before executing the next tool.";
        await settlePreExecutedToolCalls(preExecutedToolCalls);
        yield* appendMissingToolResults(messages, pendingToolCalls, reason);
        yield {
          type: "stopped",
          reason,
        };
        return yield* finish(createStoppedAgentCoreQueryLoopResult(messages, reason));
      }

      await middlewareChain.beforeToolsBatch({
        queryArgs,
        messages,
        turn,
        calls,
      });
      let toolResult: AgentCoreQueryLoopResult | null = null;
      try {
        toolResult = yield* runToolCallsStep({
          queryArgs,
          messages,
          calls,
          preExecutedToolCalls,
          middlewareChain,
          turn,
        });
      } finally {
        await middlewareChain.afterToolsBatch({
          queryArgs,
          messages,
          turn,
          calls,
        });
      }
      if (toolResult !== null) {
        return yield* finish(toolResult);
      }
      pendingToolCalls = [];
    }

    const message = `Agent run exceeded maxTurns=${maxTurns}.`;
    yield {
      type: "error",
      message,
    };
    return yield* finish({
      status: "error",
      messages,
      message,
    });
  } catch (error) {
    await middlewareChain.onError({
      queryArgs,
      messages,
      error,
    });
    if (isAgentCoreQueryStopped(queryArgs.signal)) {
      const reason = "Agent run was stopped during execution.";
      yield* appendMissingToolResults(messages, pendingToolCalls, reason);
      yield {
        type: "stopped",
        reason,
      };
      return yield* finish(createStoppedAgentCoreQueryLoopResult(messages, reason));
    }

    const message = getAgentCoreModelErrorMessage(error);
    const errorCode = classifyAgentCoreModelError(error);
    yield* appendMissingToolResults(messages, pendingToolCalls, message);
    yield {
      type: "error",
      message,
    };
    return yield* finish({
      status: "error",
      messages,
      message,
      errorCode,
    });
  }
}
