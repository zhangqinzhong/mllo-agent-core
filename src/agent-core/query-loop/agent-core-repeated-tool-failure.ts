import type { AgentCoreToolCall, AgentCoreToolResult } from "../tools/agent-core-tool-types";
import type { AgentCoreMessage } from "./agent-core-query-types";
import { createAgentCoreToolCallSignature } from "./agent-core-tool-call-signature";

type CompletedToolResult = {
  signature: string;
  content: string;
  isError: boolean;
};

const MAX_REPEATED_FAILURE_PREVIEW_CHARS = 1200;

function stripPreviousRepairGuidance(content: string): string {
  const marker = "\n\nRepair guidance for ";
  const index = content.indexOf(marker);
  return index === -1 ? content : content.slice(0, index);
}

// 裁剪上一条失败文本。重复失败提示需要可诊断，但不能把长 stdout 再塞一遍。
function previewPreviousFailure(content: string): string {
  const failure = stripPreviousRepairGuidance(content);
  if (failure.length <= MAX_REPEATED_FAILURE_PREVIEW_CHARS) {
    return failure;
  }
  return `${failure.slice(0, MAX_REPEATED_FAILURE_PREVIEW_CHARS)}\n\n[previous failure truncated]`;
}

// 找出当前 autonomous loop 中同名同参最近一次失败。新用户消息重置；同签名成功会清掉旧失败。
function latestMatchingFailedToolResult(
  messages: readonly AgentCoreMessage[],
  signature: string,
): CompletedToolResult | null {
  const callSignatures = new Map<string, string>();
  let latestFailure: CompletedToolResult | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      callSignatures.clear();
      latestFailure = null;
      continue;
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        callSignatures.set(call.id, createAgentCoreToolCallSignature(call));
      }
      continue;
    }
    const completedSignature = callSignatures.get(message.toolCallId);
    if (completedSignature === signature) {
      latestFailure =
        message.isError === true
          ? {
              signature: completedSignature,
              content: message.content,
              isError: true,
            }
          : null;
    }
  }
  return latestFailure;
}

// 为重复失败构造 synthetic tool_result。模型必须换参数、换工具或解释新依据后再继续。
function createRepeatedToolFailureResult(args: {
  call: AgentCoreToolCall;
  previousFailure: string;
}): AgentCoreToolResult {
  return {
    isError: true,
    errorKind: "repeated-failure",
    content: [
      `Repeated failed tool call unchanged for ${args.call.name}.`,
      "This autonomous loop already has a failed tool result for the same tool name and JSON arguments.",
      "Repair instruction: change the arguments, inspect state with a different tool, or explain the new evidence before retrying.",
      "",
      "Previous failure:",
      previewPreviousFailure(args.previousFailure),
    ].join("\n"),
  };
}

// 检查当前工具调用是否在原样重复上一条失败。返回 undefined 表示允许真实执行。
export function createAgentCoreRepeatedToolFailureResult(args: {
  messages: readonly AgentCoreMessage[];
  call: AgentCoreToolCall;
}): AgentCoreToolResult | undefined {
  const signature = createAgentCoreToolCallSignature(args.call);
  const previous = latestMatchingFailedToolResult(args.messages, signature);
  if (previous === null) {
    return undefined;
  }
  return createRepeatedToolFailureResult({
    call: args.call,
    previousFailure: previous.content,
  });
}
