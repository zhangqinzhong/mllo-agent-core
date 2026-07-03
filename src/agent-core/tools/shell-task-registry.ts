import type { ChildProcess } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import {
  terminateAgentCoreShellProcess,
  type AgentCoreShellTerminationResult,
} from "./shell-process-termination";
import { readAgentCoreShellTaskOutputTail } from "./shell-task-output";
import {
  appendAgentCoreShellTaskJournalEntry,
  readLatestAgentCoreShellTaskJournal,
} from "./shell-task-journal";

export type AgentCoreShellTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "orphaned";

export type AgentCoreShellTaskBackendRecord = {
  kind: string;
  remote: boolean;
  sandboxed: boolean;
  label?: string;
  cwdTrackingMode?: string;
};

export type AgentCoreShellTaskSessionRecord = {
  projectDir: string;
  runtimeDir: string;
  sessionId?: string;
};

export type AgentCoreShellTaskRecord = {
  taskId: string;
  command: string;
  cwd: string;
  outputPath: string;
  executionBackend?: AgentCoreShellTaskBackendRecord;
  session?: AgentCoreShellTaskSessionRecord;
  status: AgentCoreShellTaskStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  elapsedMs?: number;
  terminationResult?: AgentCoreShellTerminationResult;
  errorMessage?: string;
};

type AgentCoreShellTaskProcess = {
  child?: ChildProcess;
  hydrated?: boolean;
  record: AgentCoreShellTaskRecord;
};

export type AgentCoreShellTaskSnapshot = AgentCoreShellTaskRecord & {
  outputTail?: string;
};

function isPathInsideDir(root: string, filePath: string): boolean {
  const relation = relative(root, filePath);
  return relation.length > 0 && !relation.startsWith("..") && !isAbsolute(relation);
}

// 重启后只能恢复任务事实，不能恢复旧 child handle；继续显示 running 会误导 GUI 和模型。
function orphanHydratedRunningTask(record: AgentCoreShellTaskRecord): AgentCoreShellTaskRecord {
  if (record.status !== "running") {
    return record;
  }
  return {
    ...record,
    status: "orphaned",
    updatedAt: Date.now(),
    errorMessage:
      record.errorMessage ??
      "Shell task was recorded as running, but no live child process is attached after registry hydration.",
  };
}

// 后台 shell 任务注册表。它保存任务状态，实际 spawn 和权限判断由其他模块负责。
export class AgentCoreShellTaskRegistry {
  private readonly tasks = new Map<string, AgentCoreShellTaskProcess>();
  private readonly journalPath: string | undefined;
  private readonly readableOutputDirs: readonly string[];
  private journalLoaded = false;
  private persistQueue: Promise<void> = Promise.resolve();

  // 创建后台 shell 任务注册表。journalPath 存在时会把任务状态追加落盘。
  constructor(options: { journalPath?: string; readableOutputDirs?: readonly string[] } = {}) {
    this.journalPath = options.journalPath;
    this.readableOutputDirs = (options.readableOutputDirs ?? []).map((dir) => resolve(dir));
  }

  // 顺序追加任务日志。后台命令可能同时结束，写 journal 必须排队避免交错。
  private persist(record: AgentCoreShellTaskRecord): void {
    if (this.journalPath === undefined) {
      return;
    }
    this.persistQueue = this.persistQueue
      .catch(() => {
        // 上一次 journal 写失败不能让队列永久断裂；下一次状态仍要尝试落盘。
      })
      .then(async () => {
        if (this.journalPath === undefined) {
          return;
        }
        await appendAgentCoreShellTaskJournalEntry({
          journalPath: this.journalPath,
          task: record,
        });
      });
  }

  // 从 journal 懒加载历史任务。列表/查询前再 hydrate，避免启动时读无关会话日志。
  private async hydrateFromJournal(): Promise<void> {
    if (this.journalLoaded || this.journalPath === undefined) {
      return;
    }
    await this.persistQueue;
    this.journalLoaded = true;
    for (const record of await readLatestAgentCoreShellTaskJournal({
      journalPath: this.journalPath,
    })) {
      if (!this.tasks.has(record.taskId)) {
        const hydratedRecord = orphanHydratedRunningTask(record);
        this.tasks.set(record.taskId, {
          hydrated: true,
          record: hydratedRecord,
        });
        if (hydratedRecord !== record) {
          this.persist(hydratedRecord);
        }
      }
    }
  }

  // 注册正在运行的 shell 任务。后台任务需要可查询、可取消，不能只靠返回一段文本。
  register(args: {
    taskId: string;
    command: string;
    cwd: string;
    outputPath: string;
    child: ChildProcess;
    startedAt: number;
    executionBackend?: AgentCoreShellTaskBackendRecord;
    session?: AgentCoreShellTaskSessionRecord;
  }): AgentCoreShellTaskRecord {
    const record: AgentCoreShellTaskRecord = {
      taskId: args.taskId,
      command: args.command,
      cwd: args.cwd,
      outputPath: args.outputPath,
      ...(args.executionBackend === undefined ? {} : { executionBackend: args.executionBackend }),
      ...(args.session === undefined ? {} : { session: args.session }),
      status: "running",
      startedAt: args.startedAt,
      updatedAt: args.startedAt,
    };
    this.tasks.set(args.taskId, {
      child: args.child,
      record,
    });
    this.persist(record);
    return record;
  }

  // 标记任务结束。记录留在 registry 里，方便 GUI 在命令完成后仍能读取状态。
  complete(
    taskId: string,
    result: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      elapsedMs: number;
      status?: AgentCoreShellTaskStatus;
      terminationResult?: AgentCoreShellTerminationResult;
      errorMessage?: string;
    },
  ): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return;
    }
    const completedAt = Date.now();
    task.record.status =
      task.record.status === "cancelled"
        ? "cancelled"
        : (result.status ?? (result.exitCode === 0 ? "completed" : "failed"));
    task.record.exitCode = result.exitCode;
    task.record.signal = result.signal;
    task.record.elapsedMs = result.elapsedMs;
    if (result.terminationResult !== undefined) {
      task.record.terminationResult = result.terminationResult;
    }
    if (result.errorMessage !== undefined) {
      task.record.errorMessage = result.errorMessage;
    }
    task.record.completedAt = completedAt;
    task.record.updatedAt = completedAt;
    this.persist(task.record);
  }

  // 取消正在运行的任务。调用方用于 GUI stop/cancel 按钮。
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.record.status !== "running" || task.child === undefined) {
      return false;
    }
    task.record.status = "cancelled";
    task.record.terminationResult = terminateAgentCoreShellProcess(task.child, "SIGTERM");
    task.record.updatedAt = Date.now();
    this.persist(task.record);
    return true;
  }

  // 查询单个任务。includeOutputTail 用于 GUI 展开后台任务时读取日志尾部。
  async getTask(
    taskId: string,
    options?: {
      includeOutputTail?: boolean;
      maxOutputChars?: number;
    },
  ): Promise<AgentCoreShellTaskSnapshot | undefined> {
    await this.hydrateFromJournal();
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return undefined;
    }
    return await this.snapshotRecord(task, options);
  }

  // 列出所有任务。默认不读输出文件，避免列表刷新时反复读大日志。
  async listTasks(options?: {
    includeOutputTail?: boolean;
    maxOutputChars?: number;
  }): Promise<AgentCoreShellTaskSnapshot[]> {
    await this.hydrateFromJournal();
    return await Promise.all(
      Array.from(this.tasks.values()).map(async (task) => {
        return await this.snapshotRecord(task, options);
      }),
    );
  }

  // 把内部 record 复制成外部快照。避免调用方直接修改 registry 内部状态。
  private async snapshotRecord(
    task: AgentCoreShellTaskProcess,
    options?: {
      includeOutputTail?: boolean;
      maxOutputChars?: number;
    },
  ): Promise<AgentCoreShellTaskSnapshot> {
    const record = task.record;
    const snapshot: AgentCoreShellTaskSnapshot = {
      ...record,
    };
    if (options?.includeOutputTail === true) {
      if (!this.canReadOutputPath(record.outputPath, task.hydrated === true)) {
        snapshot.outputTail = "Refusing to read shell task output without a trusted output dir.";
        return snapshot;
      }
      snapshot.outputTail = await readAgentCoreShellTaskOutputTail(
        record.outputPath,
        options.maxOutputChars ?? 20_000,
      ).catch((error: unknown) => {
        return error instanceof Error ? error.message : String(error);
      });
    }
    return snapshot;
  }

  // journal 是事实流但不是任意文件读取授权；output tail 只能读本 registry 配置的输出目录。
  private canReadOutputPath(outputPath: string, hydrated: boolean): boolean {
    if (this.readableOutputDirs.length === 0) {
      return !hydrated;
    }
    const resolvedPath = resolve(outputPath);
    return this.readableOutputDirs.some((dir) => isPathInsideDir(dir, resolvedPath));
  }
}

export const defaultAgentCoreShellTaskRegistry = new AgentCoreShellTaskRegistry();
