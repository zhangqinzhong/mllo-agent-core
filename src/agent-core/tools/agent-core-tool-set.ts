import type { AgentCoreToolDefinition } from "./agent-core-tool-types";

/** 合并宿主工具时拒绝同名覆盖，避免权限与执行实现被数组顺序静默替换。 */
export function createAgentCoreToolSet(args: {
  baseTools: readonly AgentCoreToolDefinition[];
  additionalTools?: readonly AgentCoreToolDefinition[];
}): AgentCoreToolDefinition[] {
  const tools = [...args.baseTools, ...(args.additionalTools ?? [])];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate Agent Core tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
  return tools;
}
