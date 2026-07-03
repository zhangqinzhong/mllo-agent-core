import { randomUUID } from "node:crypto";
import type { AgentCoreMessage } from "../query-loop/agent-core-query-types";
import type {
  AgentCoreBudgetPolicy,
  AgentCoreBudgetState,
  AgentCoreCompactBoundary,
  AgentCoreCompactionResult,
  AgentCoreSummarizer,
  AgentCoreTokenEstimator,
} from "./agent-core-budget-types";
import { collapseAgentCoreMessages } from "./agent-core-context-collapse";
import { applyAgentCoreToolResultBudget } from "./agent-core-tool-result-budget";

export type AgentCoreWillCompactContext = {
  originalMessageCount: number;
  retainedMessageCount: number;
  summarizedMessageCount: number;
  estimatedInputTokens: number;
};

export const DEFAULT_AGENT_CORE_BUDGET_POLICY: AgentCoreBudgetPolicy = {
  maxInputTokens: 120_000,
  maxOutputTokens: 16_000,
  preservedTailMessages: 20,
  compactTriggerRatio: 0.8,
  maxToolResultChars: 20_000,
  preservedToolResultHeadChars: 6_000,
  preservedToolResultTailChars: 6_000,
  microCompactPreservedRecentToolResults: 8,
  microCompactToolResultChars: 1_200,
  toolResultProfiles: {
    shell_command: {
      maxToolResultChars: 20_000,
      preservedToolResultHeadChars: 4_000,
      preservedToolResultTailChars: 8_000,
      microCompactToolResultChars: 1_500,
    },
    grep_files: {
      maxToolResultChars: 12_000,
      preservedToolResultHeadChars: 10_000,
      preservedToolResultTailChars: 1_000,
      microCompactToolResultChars: 1_200,
    },
    read_file: {
      maxToolResultChars: 24_000,
      preservedToolResultHeadChars: 12_000,
      preservedToolResultTailChars: 4_000,
      microCompactToolResultChars: 2_000,
    },
    delegate_agent: {
      maxToolResultChars: 16_000,
      preservedToolResultHeadChars: 3_000,
      preservedToolResultTailChars: 6_000,
      microCompactToolResultChars: 1_500,
    },
    run_agent_workflow: {
      maxToolResultChars: 20_000,
      preservedToolResultHeadChars: 5_000,
      preservedToolResultTailChars: 7_000,
      microCompactToolResultChars: 2_000,
    },
  },
};

// 第一版 token 估算用字符近似，但通过接口保留未来替换 tokenizer 的位置。
export const characterApproxTokenEstimator: AgentCoreTokenEstimator = {
  estimateMessages(messages) {
    return Math.ceil(JSON.stringify(messages).length / 4);
  },
};

// 判断当前输入是否达到 compact 阈值。阈值用 ratio，而不是硬等 max 才触发。
function shouldCompact(policy: AgentCoreBudgetPolicy, estimatedInputTokens: number): boolean {
  return estimatedInputTokens >= policy.maxInputTokens * policy.compactTriggerRatio;
}

function assistantOwnsToolResult(message: AgentCoreMessage, toolResult: AgentCoreMessage): boolean {
  return (
    message.role === "assistant" &&
    toolResult.role === "tool" &&
    (message.toolCalls?.some((call) => call.id === toolResult.toolCallId) ?? false)
  );
}

function findAssistantToolCallIndex(
  messages: readonly AgentCoreMessage[],
  toolResultIndex: number,
): number | undefined {
  const toolResult = messages[toolResultIndex];
  if (toolResult?.role !== "tool") {
    return undefined;
  }
  for (let index = toolResultIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role === "user") {
      return undefined;
    }
    if (assistantOwnsToolResult(message, toolResult)) {
      return index;
    }
  }
  return undefined;
}

function findAssistantToolCallIndexForFollowingAssistant(
  messages: readonly AgentCoreMessage[],
  assistantIndex: number,
): number | undefined {
  if (messages[assistantIndex]?.role !== "assistant") {
    return undefined;
  }
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") {
      break;
    }
    const toolCallIndex = findAssistantToolCallIndex(messages, index);
    if (toolCallIndex !== undefined) {
      return toolCallIndex;
    }
  }
  return undefined;
}

function findToolTrajectoryStartIndex(
  messages: readonly AgentCoreMessage[],
  index: number,
): number | undefined {
  const message = messages[index];
  if (message?.role === "tool") {
    return findAssistantToolCallIndex(messages, index);
  }
  return findAssistantToolCallIndexForFollowingAssistant(messages, index);
}

// compact tail 不能切断 tool_call -> tool_result -> assistant 回复这条工具轨迹。
function expandTailStartToToolTrajectory(
  messages: readonly AgentCoreMessage[],
  initialStartIndex: number,
): number {
  let startIndex = initialStartIndex;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = startIndex; index < messages.length; index += 1) {
      const trajectoryStartIndex = findToolTrajectoryStartIndex(messages, index);
      if (trajectoryStartIndex !== undefined && trajectoryStartIndex < startIndex) {
        startIndex = trajectoryStartIndex;
        changed = true;
        break;
      }
    }
  }
  return startIndex;
}

// 切分需要 summary 的旧消息和必须保留的 tail。tail 保留最近交互，避免 compact 后失忆。
function splitForCompaction(
  messages: readonly AgentCoreMessage[],
  preservedTailMessages: number,
): {
  toSummarize: AgentCoreMessage[];
  retained: AgentCoreMessage[];
} {
  if (messages.length <= preservedTailMessages) {
    return {
      toSummarize: [],
      retained: [...messages],
    };
  }
  if (preservedTailMessages <= 0) {
    return {
      toSummarize: [...messages],
      retained: [],
    };
  }
  const tailStartIndex = expandTailStartToToolTrajectory(
    messages,
    Math.max(0, messages.length - preservedTailMessages),
  );
  return {
    toSummarize: messages.slice(0, tailStartIndex),
    retained: messages.slice(tailStartIndex),
  };
}

// 创建 compact boundary。boundary 会写入 JSONL，用于 resume 时识别上下文被压缩过。
function createCompactBoundary(args: {
  originalMessageCount: number;
  retainedMessageCount: number;
  summarizedMessageCount: number;
}): AgentCoreCompactBoundary {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    originalMessageCount: args.originalMessageCount,
    retainedMessageCount: args.retainedMessageCount,
    summarizedMessageCount: args.summarizedMessageCount,
  };
}

// 构建预算状态。queryLoop 和 prompt context 都应该消费同一个 budget state。
function createBudgetState(args: {
  estimatedInputTokens: number;
  compacted: boolean;
  compactedAt?: string;
  toolResultsCompacted: number;
  microCompactedToolResults: number;
  toolCallInputsCompacted: number;
}): AgentCoreBudgetState {
  return {
    estimatedInputTokens: args.estimatedInputTokens,
    compacted: args.compacted,
    compactedAt: args.compactedAt,
    toolResultsCompacted: args.toolResultsCompacted,
    microCompactedToolResults: args.microCompactedToolResults,
    toolCallInputsCompacted: args.toolCallInputsCompacted,
  };
}

// 对 messages 应用预算和 compact 策略。summary 由外部 summarizer 注入，避免写死模型实现。
export async function applyAgentCoreBudget(args: {
  messages: readonly AgentCoreMessage[];
  policy?: Partial<AgentCoreBudgetPolicy>;
  estimator?: AgentCoreTokenEstimator;
  summarizer: AgentCoreSummarizer;
  onWillCompact?: (context: AgentCoreWillCompactContext) => void | Promise<void>;
}): Promise<AgentCoreCompactionResult> {
  const policy = {
    ...DEFAULT_AGENT_CORE_BUDGET_POLICY,
    ...args.policy,
  };
  const estimator = args.estimator ?? characterApproxTokenEstimator;
  const preprocessed = applyAgentCoreToolResultBudget(args.messages, policy);
  const estimatedInputTokens = estimator.estimateMessages(preprocessed.messages);

  if (!shouldCompact(policy, estimatedInputTokens)) {
    return {
      compacted: false,
      messages: preprocessed.messages,
      budgetState: createBudgetState({
        estimatedInputTokens,
        compacted: false,
        toolResultsCompacted: preprocessed.stats.toolResultsCompacted,
        microCompactedToolResults: preprocessed.stats.microCompactedToolResults,
        toolCallInputsCompacted: preprocessed.stats.toolCallInputsCompacted,
      }),
    };
  }

  const { toSummarize, retained } = splitForCompaction(
    preprocessed.messages,
    policy.preservedTailMessages,
  );
  await args.onWillCompact?.({
    originalMessageCount: args.messages.length,
    retainedMessageCount: retained.length,
    summarizedMessageCount: toSummarize.length,
    estimatedInputTokens,
  });
  const summary = await args.summarizer.summarize(toSummarize);
  const boundary = createCompactBoundary({
    originalMessageCount: args.messages.length,
    retainedMessageCount: retained.length,
    summarizedMessageCount: toSummarize.length,
  });
  const compactedMessages = collapseAgentCoreMessages({
    boundary,
    summary,
    retainedMessages: retained,
  });
  const compactedAt = boundary.createdAt;
  const budgetState = createBudgetState({
    estimatedInputTokens: estimator.estimateMessages(compactedMessages),
    compacted: true,
    compactedAt,
    toolResultsCompacted: preprocessed.stats.toolResultsCompacted,
    microCompactedToolResults: preprocessed.stats.microCompactedToolResults,
    toolCallInputsCompacted: preprocessed.stats.toolCallInputsCompacted,
  });

  return {
    compacted: true,
    messages: compactedMessages,
    budgetState,
    record: {
      boundary,
      summary,
      budgetState,
    },
  };
}
