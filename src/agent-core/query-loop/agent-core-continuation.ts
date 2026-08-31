export type AgentCoreContinuation =
  | {
      reason: "collapse_drain_retry";
      committed: number;
    }
  | {
      reason: "reactive_compact_retry";
    }
  | {
      reason: "max_output_tokens_escalate";
    }
  | {
      reason: "max_output_tokens_recovery";
      attempt: number;
    }
  | {
      reason: "stop_hook_blocking";
    }
  | {
      reason: "token_budget_continuation";
    }
  | {
      reason: "next_turn";
    }
  | {
      reason: "elicitation_resume";
    }
  | {
      reason: "permission_resume";
    }
  | {
      reason: "permission_followup";
    };

export type AgentCoreContinuationEvent = {
  type: "continue";
  continuation: AgentCoreContinuation;
  previousContinuation?: AgentCoreContinuation;
  turn?: number;
  messageCount: number;
};

// 显式记录为什么再次进入循环；恢复和观测不能靠裸 continue 猜路径。
export function createAgentCoreContinuationEvent(args: {
  continuation: AgentCoreContinuation;
  previousContinuation?: AgentCoreContinuation;
  turn?: number;
  messageCount: number;
}): AgentCoreContinuationEvent {
  return {
    type: "continue",
    continuation: args.continuation,
    ...(args.previousContinuation === undefined
      ? {}
      : { previousContinuation: args.previousContinuation }),
    ...(args.turn === undefined ? {} : { turn: args.turn }),
    messageCount: args.messageCount,
  };
}
