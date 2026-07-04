import type { AgentCoreBudgetState } from "../budget/agent-core-budget-types";
import type { AgentCorePromptContext } from "../context/agent-core-prompt-context";
import type { AgentCorePromptProfile } from "../context/agent-core-prompt-profile";
import {
  renderAgentCoreSystemPrompt,
  renderAgentCoreSystemPromptBlocks,
} from "../context/agent-core-prompt-renderer";
import { renderAgentCoreTurnContextMessage } from "../context/agent-core-turn-context-message";
import type { AgentCorePromptBlock } from "../query-loop/agent-core-prompt-block-types";
import type { AgentCoreQueryLoopResult } from "../query-loop/agent-core-query-types";
import type { AgentCoreRunControllerOptions } from "./agent-core-run-controller-types";

function withAgentCoreRunBudgetState(args: {
  promptContext: AgentCorePromptContext;
  budgetState: AgentCoreBudgetState;
  budgetOptions: AgentCoreRunControllerOptions["budget"];
}): AgentCorePromptContext {
  return {
    ...args.promptContext,
    budget: {
      inputBudgetTokens: args.budgetOptions?.policy?.maxInputTokens,
      outputBudgetTokens: args.budgetOptions?.policy?.maxOutputTokens,
      estimatedInputTokens: args.budgetState.estimatedInputTokens,
      compacted: args.budgetState.compacted,
    },
  };
}

// 渲染本轮 system prompt。reactive compact 后预算状态会变化，所以不能只构造一次。
export function renderAgentCoreRunSystemPrompt(args: {
  promptContext: AgentCorePromptContext;
  promptProfile: AgentCorePromptProfile;
  budgetState: AgentCoreBudgetState;
  budgetOptions: AgentCoreRunControllerOptions["budget"];
}): string {
  return renderAgentCoreSystemPrompt(withAgentCoreRunBudgetState(args), {
    profile: args.promptProfile,
  });
}

export function renderAgentCoreRunSystemPromptBlocks(args: {
  promptContext: AgentCorePromptContext;
  promptProfile: AgentCorePromptProfile;
  budgetState: AgentCoreBudgetState;
  budgetOptions: AgentCoreRunControllerOptions["budget"];
}): readonly AgentCorePromptBlock[] {
  return renderAgentCoreSystemPromptBlocks(withAgentCoreRunBudgetState(args), {
    profile: args.promptProfile,
  });
}

export function renderAgentCoreRunTurnContext(args: {
  promptContext: AgentCorePromptContext;
  promptProfile: AgentCorePromptProfile;
  budgetState: AgentCoreBudgetState;
  budgetOptions: AgentCoreRunControllerOptions["budget"];
}): string {
  return renderAgentCoreTurnContextMessage(withAgentCoreRunBudgetState(args), {
    profile: args.promptProfile,
    baselineMode: "omit-current-baseline",
  });
}

// 构造 reactive compact 策略。上下文过长时要强制摘要，但仍保留调用方设置的 tail。
export function createAgentCoreReactiveCompactBudget(
  options: AgentCoreRunControllerOptions["budget"],
): AgentCoreRunControllerOptions["budget"] {
  return {
    ...options,
    policy: {
      ...options?.policy,
      maxInputTokens: 1,
      compactTriggerRatio: 0,
    },
  };
}

// 判断本次错误是否允许做 reactive compact。只重试一次，避免模型持续报错时无限循环。
export function shouldRunAgentCoreReactiveCompact(args: {
  result: AgentCoreQueryLoopResult;
  alreadyRetried: boolean;
}): boolean {
  return (
    !args.alreadyRetried &&
    args.result.status === "error" &&
    args.result.errorCode === "context-length-exceeded"
  );
}

// 判断 reactive compact 是否已经耗尽。第二次仍然上下文过长时必须停止重试。
export function shouldStopAfterAgentCoreReactiveCompact(args: {
  result: AgentCoreQueryLoopResult;
  alreadyRetried: boolean;
}): boolean {
  return (
    args.alreadyRetried &&
    args.result.status === "error" &&
    args.result.errorCode === "context-length-exceeded"
  );
}

// 构造 compact circuit breaker 文案。用户和后续 agent 需要知道不是普通模型失败。
export function createAgentCoreReactiveCompactFailureMessage(originalMessage: string): string {
  return [
    "Reactive compact retry failed: the model still reports that the context is too long after mllo compacted the conversation once.",
    "Stop retrying to avoid an infinite compact loop.",
    `Original model error: ${originalMessage}`,
  ].join("\n");
}
