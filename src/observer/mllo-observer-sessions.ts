import {
  getMlloDumpPromptsPath,
  getMlloHomePath,
} from "../agent-core/runtime-home/mllo-home-paths";
import { readAgentCoreSessionIndex } from "../agent-core/session/agent-core-session-index";
import { readMlloObserverJsonlTail } from "./mllo-observer-jsonl";
import { readMlloObserverStateThreads } from "./mllo-observer-state";
import type { MlloObserverJsonlTailOptions } from "./mllo-observer-jsonl";
import type { MlloObserverSessionDetail, MlloObserverSessionSummary } from "./mllo-observer-types";

export type MlloObserverListSessionsOptions = {
  homePath?: string;
  includeArchived?: boolean;
  limit?: number;
};

export type MlloObserverReadSessionOptions = MlloObserverListSessionsOptions &
  MlloObserverJsonlTailOptions & {
    sessionId: string;
  };

function toMillis(value: string | number | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (value === undefined) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function titleFromSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}...` : sessionId;
}

export async function listMlloObserverSessions(
  options: MlloObserverListSessionsOptions = {},
): Promise<MlloObserverSessionSummary[]> {
  const homePath = getMlloHomePath({
    homePath: options.homePath,
  });
  const byId = new Map<string, MlloObserverSessionSummary>();
  for (const indexEntry of await readAgentCoreSessionIndex(homePath)) {
    const createdAtMs = toMillis(indexEntry.createdAt);
    byId.set(indexEntry.sessionId, {
      id: indexEntry.sessionId,
      title: titleFromSessionId(indexEntry.sessionId),
      cwd: indexEntry.cwd,
      transcriptPath: indexEntry.transcriptPath,
      promptDumpPath: getMlloDumpPromptsPath(indexEntry.sessionId, {
        homePath,
      }),
      source: "index",
      createdAtMs,
      updatedAtMs: createdAtMs,
    });
  }

  let stateThreads: Awaited<ReturnType<typeof readMlloObserverStateThreads>> = [];
  try {
    stateThreads = await readMlloObserverStateThreads({
      homePath,
      includeArchived: options.includeArchived,
      limit: Math.max(options.limit ?? 100, 500),
    });
  } catch {
    stateThreads = [];
  }
  for (const thread of stateThreads) {
    const existing = byId.get(thread.id);
    byId.set(thread.id, {
      id: thread.id,
      title: thread.title || existing?.title || titleFromSessionId(thread.id),
      cwd: thread.cwd || existing?.cwd || "",
      transcriptPath: thread.rolloutPath || existing?.transcriptPath || "",
      promptDumpPath: existing?.promptDumpPath ?? getMlloDumpPromptsPath(thread.id, { homePath }),
      source: existing === undefined ? "state" : "merged",
      modelProvider: thread.modelProvider,
      ...(thread.model === undefined ? {} : { model: thread.model }),
      approvalMode: thread.approvalMode,
      sandboxPolicy: thread.sandboxPolicy,
      tokensUsed: thread.tokensUsed,
      runStatus: thread.runStatus,
      ...(thread.runMessage === undefined ? {} : { runMessage: thread.runMessage }),
      preview: thread.preview,
      createdAtMs: thread.createdAtMs || existing?.createdAtMs || 0,
      updatedAtMs: thread.updatedAtMs || existing?.updatedAtMs || thread.createdAtMs,
    });
  }

  return [...byId.values()]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, options.limit ?? 100);
}

export async function readMlloObserverSessionDetail(
  options: MlloObserverReadSessionOptions,
): Promise<MlloObserverSessionDetail | undefined> {
  const sessions = await listMlloObserverSessions({
    homePath: options.homePath,
    includeArchived: true,
    limit: 1000,
  });
  const session = sessions.find((item) => item.id === options.sessionId);
  if (session === undefined) {
    return undefined;
  }
  const readOptions: MlloObserverJsonlTailOptions = {
    maxBytes: options.maxBytes,
    maxEntries: options.maxEntries,
    redactSecrets: options.redactSecrets,
  };
  const [transcript, prompts] = await Promise.all([
    readMlloObserverJsonlTail(session.transcriptPath, readOptions),
    readMlloObserverJsonlTail(session.promptDumpPath, readOptions),
  ]);
  return {
    session,
    transcript,
    prompts,
  };
}
