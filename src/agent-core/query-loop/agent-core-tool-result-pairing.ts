import type { AgentCoreMessage, AgentCoreQueryEvent } from "./agent-core-query-types";
import type { AgentCoreToolCall, AgentCoreToolResult } from "../tools/agent-core-tool-types";

export type AgentCoreToolResultPairingRepairResult = {
  messages: AgentCoreMessage[];
  repairedToolCallIds: string[];
  repairedToolResults: {
    call: AgentCoreToolCall;
    result: AgentCoreToolResult;
  }[];
};

type ToolMessage = Extract<AgentCoreMessage, { role: "tool" }>;

// 查询历史里已经存在 tool_result 的 id。补偿逻辑必须避免重复回灌同一个工具结果。
function completedToolCallIds(messages: readonly AgentCoreMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      ids.add(message.toolCallId);
    }
  }
  return ids;
}

// 创建中断/错误时的 synthetic tool_result。原因写入模型上下文，让下一轮能理解发生了什么。
function createSyntheticToolResult(reason: string): AgentCoreToolResult {
  return {
    content: reason,
    isError: true,
    errorKind: "interrupted-tool-call",
  };
}

function createSyntheticToolMessage(
  call: AgentCoreToolCall,
  result: AgentCoreToolResult,
): ToolMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: result.content,
    isError: true,
    errorKind: result.errorKind,
  };
}

function toolMessagesByCallId(messages: readonly AgentCoreMessage[]): Map<string, ToolMessage> {
  const messagesByCallId = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (message.role === "tool" && !messagesByCallId.has(message.toolCallId)) {
      messagesByCallId.set(message.toolCallId, message);
    }
  }
  return messagesByCallId;
}

// 模型协议要求 assistant tool_call 后面跟对应 tool_result；恢复时把错位结果移回原位。
export function repairAgentCoreToolResultPairing(args: {
  messages: readonly AgentCoreMessage[];
  reason: string;
}): AgentCoreToolResultPairingRepairResult {
  const toolMessages = toolMessagesByCallId(args.messages);
  const usedToolMessageIds = new Set<string>();
  const repaired: AgentCoreMessage[] = [];
  const repairedToolCallIds: string[] = [];
  const repairedToolResults: AgentCoreToolResultPairingRepairResult["repairedToolResults"] = [];

  for (const message of args.messages) {
    if (message.role === "tool") {
      continue;
    }

    repaired.push(message);
    if (message.role !== "assistant" || (message.toolCalls?.length ?? 0) === 0) {
      continue;
    }

    for (const call of message.toolCalls ?? []) {
      const existing = toolMessages.get(call.id);
      if (existing !== undefined && !usedToolMessageIds.has(call.id)) {
        repaired.push(existing);
        usedToolMessageIds.add(call.id);
        continue;
      }

      const result = createSyntheticToolResult(args.reason);
      repaired.push(createSyntheticToolMessage(call, result));
      usedToolMessageIds.add(call.id);
      repairedToolCallIds.push(call.id);
      repairedToolResults.push({
        call,
        result,
      });
    }
  }

  return {
    messages: repaired,
    repairedToolCallIds,
    repairedToolResults,
  };
}

// 补齐缺失的 tool_result。tool_result 补齐用于维持 tool_use -> tool_result 的协议不变量。
export function* appendMissingToolResults(
  messages: AgentCoreMessage[],
  calls: readonly AgentCoreToolCall[],
  reason: string,
): Generator<AgentCoreQueryEvent, void> {
  const completedIds = completedToolCallIds(messages);
  for (const call of calls) {
    if (completedIds.has(call.id)) {
      continue;
    }

    const result = createSyntheticToolResult(reason);
    messages.push(createSyntheticToolMessage(call, result));
    yield {
      type: "tool-result",
      call,
      result,
    };
  }
}
