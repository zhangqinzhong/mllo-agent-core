import type { AgentCoreToolCall, AgentCoreToolResult } from "../tools/agent-core-tool-types";
import {
  createAgentCoreToolRepairGuidance,
  shouldAppendAgentCoreToolRepairGuidance,
} from "./agent-core-tool-repair-guidance";

// 失败结果要给模型下一步动作。schema 错误已有专用 repair instruction，避免重复加长。
export function createAgentCoreToolFailureFeedback(args: {
  call: AgentCoreToolCall;
  result: AgentCoreToolResult;
}): AgentCoreToolResult {
  if (
    args.result.isError !== true ||
    !shouldAppendAgentCoreToolRepairGuidance({
      content: args.result.content,
      errorKind: args.result.errorKind,
    })
  ) {
    return args.result;
  }
  const errorKind = args.result.errorKind ?? "tool-error";
  const guidance = createAgentCoreToolRepairGuidance({
    errorKind,
    toolName: args.call.name,
  });
  const [guidanceTitle, ...guidanceHints] = guidance;
  return {
    ...args.result,
    // 工具自报失败但没有分类时，先归入普通工具错误，后续策略再细分。
    errorKind,
    content: [
      args.result.content,
      "",
      guidanceTitle,
      ...guidanceHints.map((hint) => `- ${hint}`),
    ].join("\n"),
  };
}
