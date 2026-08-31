import type { AgentCoreJsonlSessionStore } from "../session/agent-core-jsonl-session-store";
import type { AgentCoreSessionHandle } from "../session/agent-core-session-types";
import { createAgentCoreSystemContextSnapshotEntry } from "../session/agent-core-system-context-snapshot-entry";
import type { AgentCorePromptContext } from "./agent-core-prompt-context";
import type { AgentCorePromptBlock } from "../query-loop/agent-core-prompt-block-types";

export type AgentCoreSystemContextSnapshotSession = {
  store: AgentCoreJsonlSessionStore;
  handle: AgentCoreSessionHandle;
};

export type AgentCoreSystemContextSnapshotReason = "session-created" | "compact";
export type AgentCoreSystemContextSnapshotSource = "generated" | "stored";

export type AgentCoreResolvedSystemContextSnapshot = {
  prompt: string;
  promptBlocks?: readonly AgentCorePromptBlock[];
  source: AgentCoreSystemContextSnapshotSource;
};

// 读取最新 system context snapshot。JSONL 是事实源，恢复时不能从当前环境重新猜 system prompt。
async function readLatestAgentCoreSystemContextSnapshotEntry(
  session: AgentCoreSystemContextSnapshotSession,
): Promise<AgentCoreResolvedSystemContextSnapshot | undefined> {
  const entries = await session.store.readSession(session.handle);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "system-context-snapshot") {
      return {
        prompt: entry.snapshot.prompt,
        promptBlocks: entry.snapshot.promptBlocks,
        source: "stored",
      };
    }
  }
  return undefined;
}

// 写入一条 system context snapshot。compact 是允许刷新 cached prefix 的明确边界。
export async function recordAgentCoreSystemContextSnapshot(args: {
  session: AgentCoreSystemContextSnapshotSession;
  prompt: string;
  promptBlocks?: readonly AgentCorePromptBlock[];
  promptContext: AgentCorePromptContext;
  reason: AgentCoreSystemContextSnapshotReason;
}): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    createAgentCoreSystemContextSnapshotEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      snapshot: {
        version: 1,
        reason: args.reason,
        prompt: args.prompt,
        ...(args.promptBlocks === undefined ? {} : { promptBlocks: [...args.promptBlocks] }),
        promptContext: args.promptContext,
      },
    }),
  );
}

// 解析本轮 system prompt，并标记来源；turn context 需要据此决定是否补静态基线。
export async function resolveAgentCoreSystemContextSnapshotResult(args: {
  session?: AgentCoreSystemContextSnapshotSession;
  generatedPrompt: string;
  generatedPromptBlocks?: readonly AgentCorePromptBlock[];
  promptContext: AgentCorePromptContext;
}): Promise<AgentCoreResolvedSystemContextSnapshot> {
  if (args.session === undefined) {
    return {
      prompt: args.generatedPrompt,
      promptBlocks: args.generatedPromptBlocks,
      source: "generated",
    };
  }
  const existing = await readLatestAgentCoreSystemContextSnapshotEntry(args.session);
  if (existing !== undefined) {
    return existing;
  }
  await recordAgentCoreSystemContextSnapshot({
    session: args.session,
    prompt: args.generatedPrompt,
    promptBlocks: args.generatedPromptBlocks,
    promptContext: args.promptContext,
    reason: "session-created",
  });
  return {
    prompt: args.generatedPrompt,
    promptBlocks: args.generatedPromptBlocks,
    source: "generated",
  };
}

// 兼容旧调用点：只需要 prompt 的地方不暴露 snapshot 来源。
export async function resolveAgentCoreSystemContextSnapshot(args: {
  session?: AgentCoreSystemContextSnapshotSession;
  generatedPrompt: string;
  generatedPromptBlocks?: readonly AgentCorePromptBlock[];
  promptContext: AgentCorePromptContext;
}): Promise<string> {
  return (await resolveAgentCoreSystemContextSnapshotResult(args)).prompt;
}
