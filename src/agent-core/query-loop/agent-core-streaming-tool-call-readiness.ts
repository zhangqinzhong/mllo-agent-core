import type { AgentCoreToolCall } from "../tools/agent-core-tool-types";

// 流式预执行发生在模型 turn 完全结束前，只允许名字和 JSON 都已经确定的调用提前跑。
export function isAgentCoreStreamingToolCallReadyForPreExecution(call: AgentCoreToolCall): boolean {
  return call.name.trim().length > 0 && call.inputParseStatus === undefined;
}
