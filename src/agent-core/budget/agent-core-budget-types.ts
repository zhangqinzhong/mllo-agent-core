import type { AgentCoreMessage } from "../query-loop/agent-core-query-types";

export type AgentCoreToolResultBudgetProfile = {
  maxToolResultChars?: number;
  preservedToolResultHeadChars?: number;
  preservedToolResultTailChars?: number;
  microCompactToolResultChars?: number;
};

export type AgentCoreBudgetPolicy = {
  contextWindowTokens?: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  compactThresholdTokens?: number;
  preservedTailMessages: number;
  compactTriggerRatio: number;
  maxToolResultChars: number;
  preservedToolResultHeadChars: number;
  preservedToolResultTailChars: number;
  microCompactPreservedRecentToolResults: number;
  microCompactToolResultChars: number;
  toolResultProfiles: Record<string, AgentCoreToolResultBudgetProfile>;
};

export type AgentCoreBudgetState = {
  contextWindowTokens?: number;
  inputBudgetTokens?: number;
  outputBudgetTokens?: number;
  compactThresholdTokens?: number;
  estimatedInputTokens: number;
  estimatedOutputTokens?: number;
  compacted: boolean;
  compactedAt?: string;
  toolResultsCompacted?: number;
  microCompactedToolResults?: number;
  toolCallInputsCompacted?: number;
};

export type AgentCoreCompactBoundary = {
  id: string;
  createdAt: string;
  originalMessageCount: number;
  retainedMessageCount: number;
  summarizedMessageCount: number;
};

export type AgentCoreCompactRecord = {
  boundary: AgentCoreCompactBoundary;
  summary: string;
  budgetState?: AgentCoreBudgetState;
};

export type AgentCoreTokenEstimator = {
  estimateMessages: (messages: readonly AgentCoreMessage[]) => number;
};

export type AgentCoreSummarizer = {
  summarize: (messages: readonly AgentCoreMessage[]) => Promise<string>;
};

export type AgentCoreCompactionResult =
  | {
      compacted: false;
      messages: AgentCoreMessage[];
      budgetState: AgentCoreBudgetState;
    }
  | {
      compacted: true;
      messages: AgentCoreMessage[];
      budgetState: AgentCoreBudgetState;
      record: AgentCoreCompactRecord;
    };
