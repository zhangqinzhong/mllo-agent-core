import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AgentCorePlanItemStatus = "pending" | "in_progress" | "completed";

export type AgentCorePlanItem = {
  step: string;
  activeForm?: string;
  status: AgentCorePlanItemStatus;
};

export type AgentCorePlanSnapshot = {
  explanation?: string;
  items: AgentCorePlanItem[];
  updatedAt: string;
};

export type AgentCorePlanJournalEntry = {
  kind: "plan";
  recordedAt: number;
  plan: AgentCorePlanSnapshot;
};

// JSONL 保留 plan 历史；读取 prompt 时只取最后一条快照。
function serializePlanEntry(entry: AgentCorePlanJournalEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

// 容忍空行，避免手工排查 journal 时留下的空白破坏恢复。
function parsePlanJournal(content: string): AgentCorePlanJournalEntry[] {
  const entries: AgentCorePlanJournalEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as AgentCorePlanJournalEntry);
    } catch {
      // plan journal 只恢复最近状态；跳过坏行比让 context builder 启动失败更安全。
    }
  }
  return entries;
}

// 追加 plan 快照。plan 是运行态状态，不写进用户项目文件。
export async function appendAgentCorePlanJournalEntry(args: {
  journalPath: string;
  plan: AgentCorePlanSnapshot;
}): Promise<void> {
  await mkdir(dirname(args.journalPath), {
    recursive: true,
  });
  await appendFile(
    args.journalPath,
    serializePlanEntry({
      kind: "plan",
      recordedAt: Date.now(),
      plan: args.plan,
    }),
    "utf8",
  );
}

// 读取最新 plan 快照。没有 journal 时返回 undefined，prompt 渲染为 none。
export async function readLatestAgentCorePlanJournal(args: {
  journalPath: string;
}): Promise<AgentCorePlanSnapshot | undefined> {
  const content = await readFile(args.journalPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const entries = parsePlanJournal(content);
  return entries.at(-1)?.plan;
}
