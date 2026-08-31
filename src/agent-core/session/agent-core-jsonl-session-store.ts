import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAgentCoreProjectDir, getAgentCoreTranscriptPath } from "./agent-core-session-paths";
import { appendAgentCoreSessionIndexEntry } from "./agent-core-session-index";
import {
  readAgentCoreJsonlWindow,
  type AgentCoreJsonlWindow,
} from "./agent-core-jsonl-window-reader";
import { appendAgentCoreTranscriptSideIndexEntry } from "./agent-core-transcript-side-index";
import {
  createAgentCoreSessionTimestamp,
  createAgentCoreMetadataEntry,
  getExistingAgentCoreTranscriptByteLength,
  parseAgentCoreSessionJsonl,
  serializeAgentCoreSessionEntry,
  withAgentCoreSessionEntryEnvelope,
} from "./agent-core-session-entry-envelope";
import {
  createAgentCoreCheckpointRestoreEventEntry,
  type AgentCoreCheckpointRestoreEventEntryArgs,
} from "./agent-core-checkpoint-restore-event-entry";
import {
  createAgentCoreWorkerToolEventEntry,
  type AgentCoreWorkerToolEventEntryArgs,
} from "./agent-core-worker-tool-event-entry";
import type {
  AgentCoreSessionCreateOptions,
  AgentCoreSessionEntry,
  AgentCoreSessionHandle,
  AgentCoreSessionStoreOptions,
  AgentCoreThreadStateSnapshot,
} from "./agent-core-session-types";

type AgentCoreMessageSessionEntry = Extract<AgentCoreSessionEntry, { kind: "message" }>;
type AgentCoreTimelineEventSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: "timeline-event" }
>;
type AgentCoreHookEventSessionEntry = Extract<AgentCoreSessionEntry, { kind: "hook-event" }>;
type AgentCoreInteractionRequestSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: "interaction-request-event" }
>;
type AgentCoreToolPermissionSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: "permission-event"; source?: "tool" }
>;
type AgentCoreWorkerPermissionSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: "permission-event"; source: "worker" }
>;
type AgentCoreElicitationSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: "elicitation-event" }
>;
type AgentCoreBudgetSessionEntry = Extract<AgentCoreSessionEntry, { kind: "budget-event" }>;
type AgentCoreCompactSessionEntry = Extract<AgentCoreSessionEntry, { kind: "compact-record" }>;
type AgentCoreMemorySessionEntry = Extract<AgentCoreSessionEntry, { kind: "memory-event" }>;
type AgentCoreThreadStateSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: "thread-state-event" }
>;

// JSONL 会话存储器。它只负责稳定读写 transcript，不决定事件业务语义。
export class AgentCoreJsonlSessionStore {
  private readonly configDir: string;

  // 保存 runtime home。宿主应用负责决定默认目录，core 不直接绑定 ~/.mllo。
  constructor(options: AgentCoreSessionStoreOptions) {
    this.configDir = options.configDir;
  }

  // 创建 session 文件。这里立即写 metadata，避免 sessionId 和 projectDir 漂移。
  async createSession(options: AgentCoreSessionCreateOptions): Promise<AgentCoreSessionHandle> {
    const sessionId = options.sessionId ?? randomUUID();
    const createdAt = createAgentCoreSessionTimestamp();
    const projectDir = getAgentCoreProjectDir(options.cwd, this.configDir);
    const transcriptPath = getAgentCoreTranscriptPath({
      cwd: options.cwd,
      sessionId,
      configDir: this.configDir,
      startedAt: createdAt,
    });
    const handle: AgentCoreSessionHandle = {
      sessionId,
      cwd: options.cwd,
      projectDir,
      transcriptPath,
    };

    await mkdir(dirname(transcriptPath), {
      recursive: true,
    });
    await this.appendEntry(
      handle,
      createAgentCoreMetadataEntry({
        sessionId,
        cwd: options.cwd,
        workspaceRoots: options.workspaceRoots,
        createdAt,
      }),
    );
    await appendAgentCoreSessionIndexEntry({
      configDir: this.configDir,
      sessionId,
      cwd: options.cwd,
      workspaceRoots: options.workspaceRoots,
      projectDir,
      transcriptPath,
      createdAt,
    });
    return handle;
  }

  // 追加一条 JSONL entry。调用方负责决定 message/event/hook/budget 的具体语义。
  async appendEntry(handle: AgentCoreSessionHandle, entry: AgentCoreSessionEntry): Promise<void> {
    await mkdir(dirname(handle.transcriptPath), {
      recursive: true,
    });
    const serialized = serializeAgentCoreSessionEntry(entry);
    const byteOffset = await getExistingAgentCoreTranscriptByteLength(handle.transcriptPath);
    await appendFile(handle.transcriptPath, serialized, "utf8");
    await appendAgentCoreTranscriptSideIndexEntry({
      transcriptPath: handle.transcriptPath,
      entry,
      byteOffset,
      byteLength: Buffer.byteLength(serialized, "utf8"),
    });
  }

  // 快捷追加 message。queryLoop 接入 session store 后会用这个记录可恢复上下文。
  async appendMessage(
    handle: AgentCoreSessionHandle,
    message: AgentCoreMessageSessionEntry,
  ): Promise<void> {
    await this.appendEntry(handle, message);
  }

  // 读取完整 session transcript。只给审计和小测试使用，长会话恢复应走 window 或 side index。
  async readSession(handle: AgentCoreSessionHandle): Promise<AgentCoreSessionEntry[]> {
    const content = await readFile(handle.transcriptPath, "utf8");
    return parseAgentCoreSessionJsonl(content);
  }

  // 读取 session 的 head/tail 窗口。长会话恢复不应总是把完整 JSONL 放进内存。
  async readSessionWindow(
    handle: AgentCoreSessionHandle,
    options: {
      headEntries: number;
      tailEntries: number;
    },
  ): Promise<AgentCoreJsonlWindow> {
    return await readAgentCoreJsonlWindow({
      path: handle.transcriptPath,
      headEntries: options.headEntries,
      tailEntries: options.tailEntries,
    });
  }

  // 创建一条 message entry。拆出来是为了保持写入字段顺序稳定。
  createMessageEntry(args: {
    sessionId: string;
    cwd: string;
    message: AgentCoreMessageSessionEntry["message"];
  }): AgentCoreMessageSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "message",
      sessionId: args.sessionId,
      cwd: args.cwd,
      message: args.message,
    });
  }

  // 创建一条 timeline event entry。GUI 和 replay 都可以从这类记录恢复进度。
  createTimelineEventEntry(args: {
    sessionId: string;
    cwd: string;
    event: AgentCoreTimelineEventSessionEntry["event"];
  }): AgentCoreTimelineEventSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "timeline-event",
      sessionId: args.sessionId,
      cwd: args.cwd,
      event: args.event,
    });
  }

  // 创建一条 hook event entry。hook 需要单独审计，不能只混在 timeline 里。
  createHookEventEntry(args: {
    sessionId: string;
    cwd: string;
    hookName: string;
    phase: AgentCoreHookEventSessionEntry["phase"];
    status: AgentCoreHookEventSessionEntry["status"];
    content?: string;
  }): AgentCoreHookEventSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "hook-event",
      sessionId: args.sessionId,
      cwd: args.cwd,
      hookName: args.hookName,
      phase: args.phase,
      status: args.status,
      content: args.content,
    });
  }

  // 创建 durable interaction request；它必须在调用宿主 callback 前写入。
  createInteractionRequestEventEntry(args: {
    sessionId: string;
    cwd: string;
    interactionId: string;
    requestKey: string;
    messageCount: number;
    request: AgentCoreInteractionRequestSessionEntry["request"];
  }): AgentCoreInteractionRequestSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "interaction-request-event",
      version: 1,
      sessionId: args.sessionId,
      cwd: args.cwd,
      interactionId: args.interactionId,
      requestKey: args.requestKey,
      messageCount: args.messageCount,
      request: args.request,
    });
  }

  // 创建一条 permission event entry。用户审批是审计事实，不能只从后续 tool result 推断。
  createPermissionEventEntry(args: {
    sessionId: string;
    cwd: string;
    call: AgentCoreToolPermissionSessionEntry["call"];
    request: AgentCoreToolPermissionSessionEntry["request"];
    response: AgentCoreToolPermissionSessionEntry["response"];
    interactionId?: string;
    resolutionSource?: AgentCoreToolPermissionSessionEntry["resolutionSource"];
  }): AgentCoreToolPermissionSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "permission-event",
      source: "tool",
      sessionId: args.sessionId,
      cwd: args.cwd,
      call: args.call,
      request: args.request,
      response: args.response,
      ...(args.interactionId === undefined ? {} : { interactionId: args.interactionId }),
      ...(args.resolutionSource === undefined ? {} : { resolutionSource: args.resolutionSource }),
    });
  }

  // 创建一条 worker permission event entry。外部 agent 的审批也必须独立审计。
  createWorkerPermissionEventEntry(args: {
    sessionId: string;
    cwd: string;
    workerId: AgentCoreWorkerPermissionSessionEntry["workerId"];
    request: AgentCoreWorkerPermissionSessionEntry["request"];
    response: AgentCoreWorkerPermissionSessionEntry["response"];
  }): AgentCoreWorkerPermissionSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "permission-event",
      source: "worker",
      sessionId: args.sessionId,
      cwd: args.cwd,
      workerId: args.workerId,
      request: args.request,
      response: args.response,
    });
  }

  // 创建一条 worker tool event entry。第三方 agent 内部工具调用也要可审计。
  createWorkerToolEventEntry(args: AgentCoreWorkerToolEventEntryArgs) {
    return createAgentCoreWorkerToolEventEntry(args);
  }

  // 创建一条 elicitation event entry。用户回答/取消必须独立审计，不能只藏在 tool_result 里。
  createElicitationEventEntry(args: {
    sessionId: string;
    cwd: string;
    call: AgentCoreElicitationSessionEntry["call"];
    request: AgentCoreElicitationSessionEntry["request"];
    response: AgentCoreElicitationSessionEntry["response"];
    interactionId?: string;
    resolutionSource?: AgentCoreElicitationSessionEntry["resolutionSource"];
  }): AgentCoreElicitationSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "elicitation-event",
      sessionId: args.sessionId,
      cwd: args.cwd,
      call: args.call,
      request: args.request,
      response: args.response,
      ...(args.interactionId === undefined ? {} : { interactionId: args.interactionId }),
      ...(args.resolutionSource === undefined ? {} : { resolutionSource: args.resolutionSource }),
    });
  }

  // 创建一条 thread state entry。SQLite 可由 JSONL 重建，因此当前态也要进入 transcript。
  createThreadStateEventEntry(args: {
    sessionId: string;
    cwd: string;
    snapshot: AgentCoreThreadStateSnapshot;
  }): AgentCoreThreadStateSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "thread-state-event",
      sessionId: args.sessionId,
      cwd: args.cwd,
      snapshot: args.snapshot,
    });
  }

  // 创建一条 budget event entry。预算变化要写 JSONL，方便恢复和审计 compact 原因。
  createBudgetEventEntry(args: {
    sessionId: string;
    cwd: string;
    inputTokens?: number;
    outputTokens?: number;
    toolResultChars?: number;
    messageCount?: number;
    compacted?: boolean;
  }): AgentCoreBudgetSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "budget-event",
      sessionId: args.sessionId,
      cwd: args.cwd,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      toolResultChars: args.toolResultChars,
      messageCount: args.messageCount,
      compacted: args.compacted,
    });
  }

  // 创建一条 compact record entry。它记录 summary 和 boundary，resume 时可识别压缩点。
  createCompactRecordEntry(args: {
    sessionId: string;
    cwd: string;
    record: AgentCoreCompactSessionEntry["record"];
  }): AgentCoreCompactSessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "compact-record",
      sessionId: args.sessionId,
      cwd: args.cwd,
      record: args.record,
    });
  }

  // 创建一条 memory event entry。compact 写入长期记忆时也要有 JSONL 审计记录。
  createMemoryEventEntry(args: {
    sessionId: string;
    cwd: string;
    scope: AgentCoreMemorySessionEntry["scope"];
    path: string;
    compactId: string;
    summary: string;
  }): AgentCoreMemorySessionEntry {
    return withAgentCoreSessionEntryEnvelope({
      kind: "memory-event",
      sessionId: args.sessionId,
      cwd: args.cwd,
      scope: args.scope,
      path: args.path,
      compactId: args.compactId,
      summary: args.summary,
    });
  }

  // 创建一条 checkpoint restore entry。恢复文件是用户动作，必须能从 JSONL 审计。
  createCheckpointRestoreEventEntry(args: AgentCoreCheckpointRestoreEventEntryArgs) {
    return createAgentCoreCheckpointRestoreEventEntry(args);
  }
}
