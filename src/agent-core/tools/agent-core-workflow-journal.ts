import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AgentCoreWorkflowTaskJournalStatus =
  | "pending"
  | "running"
  | "completed"
  | "denied"
  | "failed"
  | "skipped";

export type AgentCoreWorkflowTaskJournalRecord = {
  id: string;
  agentId: string;
  prompt: string;
  dependsOn?: string[];
  status: AgentCoreWorkflowTaskJournalStatus;
  content?: string;
  updatedAt: string;
};

export type AgentCoreWorkflowRunJournalRecord = {
  runId: string;
  goal: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  tasks: AgentCoreWorkflowTaskJournalRecord[];
};

export type AgentCoreWorkflowJournalEntry = {
  kind: "workflow-run";
  recordedAt: string;
  run: AgentCoreWorkflowRunJournalRecord;
};

function serializeWorkflowEntry(entry: AgentCoreWorkflowJournalEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

function parseWorkflowJournal(content: string): AgentCoreWorkflowJournalEntry[] {
  const entries: AgentCoreWorkflowJournalEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as AgentCoreWorkflowJournalEntry);
    } catch {
      // workflow journal 是可重建状态；坏行不能破坏当前会话恢复。
    }
  }
  return entries;
}

// 追加 workflow run 快照。workflow 是多 agent 编排事实，不能只保留最终文本。
export async function appendAgentCoreWorkflowJournalEntry(args: {
  journalPath: string;
  run: AgentCoreWorkflowRunJournalRecord;
}): Promise<void> {
  await mkdir(dirname(args.journalPath), {
    recursive: true,
  });
  await appendFile(
    args.journalPath,
    serializeWorkflowEntry({
      kind: "workflow-run",
      recordedAt: new Date().toISOString(),
      run: args.run,
    }),
    "utf8",
  );
}

// 读取每个 runId 的最新状态。JSONL 留完整历史，GUI 列表只需要最新快照。
export async function readLatestAgentCoreWorkflowJournal(args: {
  journalPath: string;
}): Promise<AgentCoreWorkflowRunJournalRecord[]> {
  const content = await readFile(args.journalPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const latest = new Map<string, AgentCoreWorkflowRunJournalRecord>();
  for (const entry of parseWorkflowJournal(content)) {
    latest.set(entry.run.runId, entry.run);
  }
  return Array.from(latest.values());
}
