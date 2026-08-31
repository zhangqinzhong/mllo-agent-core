import type { AgentCoreModelErrorCode } from "../model/agent-core-model-error-classification";
import type { AgentCoreQueryLoopResult } from "./agent-core-query-types";

export type AgentCoreTerminal =
  | {
      reason: "completed";
    }
  | {
      reason: "waiting_for_permission";
      toolName: string;
      toolCallId: string;
      message: string;
    }
  | {
      reason: "waiting_for_elicitation";
      toolName: string;
      toolCallId: string;
      message: string;
    }
  | {
      reason: "permission_denied";
      toolName: string;
      toolCallId: string;
      message: string;
    }
  | {
      reason: "stopped";
      message: string;
    }
  | {
      reason: "max_turns";
      turnCount: number;
      message: string;
    }
  | {
      reason: "error";
      message: string;
      errorCode?: AgentCoreModelErrorCode;
    };

export type AgentCoreTerminalEvent = {
  type: "terminal";
  terminal: AgentCoreTerminal;
  messageCount: number;
};

function createToolTerminal(args: {
  reason: "waiting_for_permission" | "waiting_for_elicitation" | "permission_denied";
  toolName: string;
  toolCallId: string;
  message: string;
}): AgentCoreTerminal {
  return {
    reason: args.reason,
    toolName: args.toolName,
    toolCallId: args.toolCallId,
    message: args.message,
  };
}

export function createAgentCoreTerminalFromResult(
  result: AgentCoreQueryLoopResult,
): AgentCoreTerminal {
  switch (result.status) {
    case "completed":
      return {
        reason: "completed",
      };
    case "waiting-for-permission":
      return createToolTerminal({
        reason: "waiting_for_permission",
        toolName: result.call.name,
        toolCallId: result.call.id,
        message: result.decision.reason,
      });
    case "waiting-for-elicitation":
      return createToolTerminal({
        reason: "waiting_for_elicitation",
        toolName: result.call.name,
        toolCallId: result.call.id,
        message: result.request.question,
      });
    case "denied":
      return createToolTerminal({
        reason: "permission_denied",
        toolName: result.call.name,
        toolCallId: result.call.id,
        message: result.decision.reason,
      });
    case "stopped":
      return {
        reason: "stopped",
        message: result.reason,
      };
    case "error":
      return {
        reason: "error",
        message: result.message,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      };
  }
}

export function createAgentCoreTerminalEvent(args: {
  result: AgentCoreQueryLoopResult;
  terminal: AgentCoreTerminal;
}): AgentCoreTerminalEvent {
  return {
    type: "terminal",
    terminal: args.terminal,
    messageCount: args.result.messages.length,
  };
}

export function withAgentCoreTerminal<T extends AgentCoreQueryLoopResult>(
  result: T,
  terminal: AgentCoreTerminal,
): T {
  return {
    ...result,
    terminal,
  };
}
