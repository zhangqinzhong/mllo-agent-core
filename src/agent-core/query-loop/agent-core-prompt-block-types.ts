export type AgentCorePromptCacheScope = "global" | "session" | "turn" | "uncached";

export type AgentCorePromptBlock = {
  name: string;
  text: string;
  cacheScope: AgentCorePromptCacheScope;
};

export const MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

// 保持 block 顺序稳定。Anthropic 用它映射 cache_control，OpenAI 用它获得自动前缀缓存。
export function joinAgentCorePromptBlocks(blocks: readonly AgentCorePromptBlock[]): string {
  return blocks
    .filter((block) => block.text.length > 0)
    .map((block) => block.text)
    .join("\n\n");
}
