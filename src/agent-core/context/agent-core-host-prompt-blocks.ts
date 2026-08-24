import type { AgentCorePromptBlock } from "../query-loop/agent-core-prompt-block-types";

// 宿主 prompt block 追加在 Core 基线之后；重名会让缓存与观测无法判断真实来源。
export function appendAgentCoreHostPromptBlocks(
  baseBlocks: readonly AgentCorePromptBlock[],
  additionalBlocks: readonly AgentCorePromptBlock[] | undefined,
): AgentCorePromptBlock[] {
  const blocks = [...baseBlocks];
  const names = new Set(blocks.map((block) => block.name));
  for (const block of additionalBlocks ?? []) {
    const name = block.name.trim();
    const text = block.text.trim();
    if (name.length === 0) {
      throw new Error("Agent Core host prompt block name is required.");
    }
    if (text.length === 0) {
      throw new Error(`Agent Core host prompt block ${name} text is required.`);
    }
    if (names.has(name)) {
      throw new Error(`Duplicate Agent Core prompt block name: ${name}`);
    }
    names.add(name);
    blocks.push({
      ...block,
      name,
      text,
    });
  }
  return blocks;
}
