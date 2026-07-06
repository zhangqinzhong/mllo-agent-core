import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import {
  flushAgentCoreLangfuseRuntime,
  resolveAgentCoreLangfuseTracing,
} from "../agent-core/observability/agent-core-langfuse-runtime";
import type { AgentCoreLangfuseTracingOptions } from "../agent-core/observability/agent-core-langfuse-options";
import { ensureAgentCoreLangfuseRuntime } from "../agent-core/observability/agent-core-langfuse-runtime";
import { createAgentCoreLangfuseUsageDetails } from "../agent-core/observability/agent-core-langfuse-summaries";
import {
  normalizeAnthropicModelUsage,
  normalizeOpenAIModelUsage,
} from "../agent-core/model/agent-core-model-usage";
import {
  getMlloExternalTraceDir,
  listMlloExternalTraceLogs,
  readMlloExternalTraceLog,
} from "./mllo-external-trace-jsonl";
import type {
  MlloExternalTraceJsonlOptions,
  MlloExternalTraceProtocol,
  MlloExternalTraceRecord,
  MlloExternalTraceSource,
} from "./mllo-external-trace-types";

export type MlloExternalTraceLangfuseGeneration = {
  recordId: string;
  source: MlloExternalTraceSource;
  protocol: MlloExternalTraceProtocol;
  traceName: string;
  name: string;
  startedAt: Date;
  completedAt?: Date;
  model?: string;
  input?: unknown;
  output?: unknown;
  usageDetails?: Record<string, number>;
  level?: "DEFAULT" | "ERROR";
  statusMessage?: string;
  tags: string[];
  metadata: Record<string, unknown>;
};

export type MlloExternalTraceLangfuseWriter = (
  generation: MlloExternalTraceLangfuseGeneration,
) => Promise<void>;

export type MlloExternalTraceLangfuseExportOptions = MlloExternalTraceJsonlOptions & {
  source?: MlloExternalTraceSource;
  maxEntries?: number;
  statePath?: string;
  langfuse?: AgentCoreLangfuseTracingOptions;
  writer?: MlloExternalTraceLangfuseWriter;
};

export type MlloExternalTraceLangfuseExportResult = {
  scanned: number;
  exported: number;
  skipped: number;
  failed: number;
  disabled: boolean;
};

type MlloExternalTraceLangfuseExportState = {
  schemaVersion: 1;
  exported: Record<string, string[]>;
};

const DEFAULT_MAX_ENTRIES = 1000;
const STATE_FILE = ".langfuse-export-state.json";
const MAX_EXPORTED_IDS_PER_SOURCE = 5000;

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function asExternalTraceRecord(value: unknown): MlloExternalTraceRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<MlloExternalTraceRecord>;
  return record.type === "external_trace" &&
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    typeof record.source === "string" &&
    (record.protocol === "anthropic" || record.protocol === "openai") &&
    typeof record.startedAt === "string" &&
    typeof record.upstreamUrl === "string" &&
    record.request !== undefined
    ? (record as MlloExternalTraceRecord)
    : undefined;
}

function statePath(options: MlloExternalTraceLangfuseExportOptions): string {
  return options.statePath ?? join(getMlloExternalTraceDir(options), STATE_FILE);
}

async function readExportState(
  options: MlloExternalTraceLangfuseExportOptions,
): Promise<MlloExternalTraceLangfuseExportState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(options), "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Partial<MlloExternalTraceLangfuseExportState>).schemaVersion === 1
    ) {
      return parsed as MlloExternalTraceLangfuseExportState;
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  return {
    schemaVersion: 1,
    exported: {},
  };
}

async function writeExportState(
  options: MlloExternalTraceLangfuseExportOptions,
  state: MlloExternalTraceLangfuseExportState,
): Promise<void> {
  const path = statePath(options);
  await mkdir(dirname(path), {
    recursive: true,
  });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function hasExported(state: MlloExternalTraceLangfuseExportState, record: MlloExternalTraceRecord) {
  return state.exported[record.source]?.includes(record.id) === true;
}

function markExported(
  state: MlloExternalTraceLangfuseExportState,
  record: MlloExternalTraceRecord,
): void {
  const existing = state.exported[record.source] ?? [];
  state.exported[record.source] = [...existing, record.id].slice(-MAX_EXPORTED_IDS_PER_SOURCE);
}

function usageDetails(record: MlloExternalTraceRecord): Record<string, number> | undefined {
  const usage = record.response?.usage;
  if (usage === undefined) {
    return undefined;
  }
  return createAgentCoreLangfuseUsageDetails(
    record.protocol === "anthropic"
      ? normalizeAnthropicModelUsage(usage)
      : normalizeOpenAIModelUsage(usage),
  );
}

function upstreamHost(upstreamUrl: string): string {
  try {
    return new URL(upstreamUrl).host;
  } catch {
    return upstreamUrl.slice(0, 200);
  }
}

function recordInput(record: MlloExternalTraceRecord): unknown {
  return (
    record.request.body ?? {
      method: record.request.method,
      pathname: record.request.pathname,
      model: record.request.model,
      stream: record.request.stream,
      messageCount: record.request.messageCount,
      systemBlockCount: record.request.systemBlockCount,
      toolCount: record.request.toolCount,
      toolNames: record.request.toolNames,
      bodyBytes: record.request.bodyBytes,
    }
  );
}

function recordOutput(record: MlloExternalTraceRecord): unknown {
  if (record.error !== undefined) {
    return {
      error: record.error,
    };
  }
  if (record.response === undefined) {
    return undefined;
  }
  return (
    record.response.body ??
    record.response.bodyText ?? {
      statusCode: record.response.statusCode,
      contentType: record.response.contentType,
      eventTypes: record.response.eventTypes,
      usage: record.response.usage,
      stopReason: record.response.stopReason,
      toolUseNames: record.response.toolUseNames,
      bodyBytes: record.response.bodyBytes,
      truncatedBody: record.response.truncatedBody,
    }
  );
}

export function createMlloExternalTraceLangfuseGeneration(
  record: MlloExternalTraceRecord,
): MlloExternalTraceLangfuseGeneration {
  const traceName = `external.${record.source}.run`;
  return {
    recordId: record.id,
    source: record.source,
    protocol: record.protocol,
    traceName,
    name: `${record.protocol}.${record.request.pathname}`,
    startedAt: new Date(record.startedAt),
    ...(record.completedAt === undefined ? {} : { completedAt: new Date(record.completedAt) }),
    ...(record.request.model === undefined ? {} : { model: record.request.model }),
    input: recordInput(record),
    output: recordOutput(record),
    usageDetails: usageDetails(record),
    ...(record.error === undefined
      ? {}
      : {
          level: "ERROR" as const,
          statusMessage: record.error.message,
        }),
    tags: ["external-agent", record.source, `${record.protocol}-compatible`],
    metadata: {
      source: record.source,
      protocol: record.protocol,
      externalTraceId: record.id,
      upstreamHost: upstreamHost(record.upstreamUrl),
      pathname: record.request.pathname,
      method: record.request.method,
      stream: record.request.stream,
      statusCode: record.response?.statusCode,
      durationMs: record.durationMs,
      proxy: "mllo-trace-proxy",
    },
  };
}

async function writeMlloExternalTraceLangfuseGeneration(args: {
  generation: MlloExternalTraceLangfuseGeneration;
  langfuse?: AgentCoreLangfuseTracingOptions;
}): Promise<boolean> {
  const config = resolveAgentCoreLangfuseTracing(args.langfuse);
  if (config === undefined) {
    return false;
  }
  await ensureAgentCoreLangfuseRuntime(config);
  const observation = propagateAttributes(
    {
      traceName: args.generation.traceName,
      sessionId: args.generation.recordId,
      tags: args.generation.tags,
      metadata: {
        source: args.generation.source,
        protocol: args.generation.protocol,
        externalTraceId: args.generation.recordId,
      },
    },
    () =>
      startObservation(
        args.generation.name,
        {
          input: args.generation.input,
          output: args.generation.output,
          model: args.generation.model,
          usageDetails: args.generation.usageDetails,
          metadata: args.generation.metadata,
          level: args.generation.level,
          statusMessage: args.generation.statusMessage,
        },
        {
          asType: "generation",
          startTime: args.generation.startedAt,
        },
      ),
  );
  observation.end(args.generation.completedAt);
  await flushAgentCoreLangfuseRuntime();
  return true;
}

export async function exportMlloExternalTraceRecordToLangfuse(args: {
  record: MlloExternalTraceRecord;
  langfuse?: AgentCoreLangfuseTracingOptions;
  writer?: MlloExternalTraceLangfuseWriter;
}): Promise<"exported" | "disabled"> {
  const generation = createMlloExternalTraceLangfuseGeneration(args.record);
  if (args.writer !== undefined) {
    await args.writer(generation);
    return "exported";
  }
  return (await writeMlloExternalTraceLangfuseGeneration({
    generation,
    langfuse: args.langfuse,
  }))
    ? "exported"
    : "disabled";
}

export async function exportMlloExternalTraceLogsToLangfuse(
  options: MlloExternalTraceLangfuseExportOptions = {},
): Promise<MlloExternalTraceLangfuseExportResult> {
  const state = await readExportState(options);
  const logs =
    options.source === undefined
      ? await listMlloExternalTraceLogs(options)
      : [
          {
            source: options.source,
            path: "",
            fileBytes: 0,
            updatedAtMs: 0,
          },
        ];
  const result: MlloExternalTraceLangfuseExportResult = {
    scanned: 0,
    exported: 0,
    skipped: 0,
    failed: 0,
    disabled: false,
  };

  for (const log of logs) {
    const traceLog = await readMlloExternalTraceLog({
      homePath: options.homePath,
      source: log.source,
      includeParsed: true,
      redactSecrets: false,
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    });
    for (const entry of traceLog.entries) {
      const record = asExternalTraceRecord(entry.parsed);
      if (record === undefined) {
        continue;
      }
      result.scanned += 1;
      if (hasExported(state, record)) {
        result.skipped += 1;
        continue;
      }
      try {
        const status = await exportMlloExternalTraceRecordToLangfuse({
          record,
          langfuse: options.langfuse,
          writer: options.writer,
        });
        if (status === "disabled") {
          result.disabled = true;
          continue;
        }
        markExported(state, record);
        result.exported += 1;
      } catch {
        result.failed += 1;
      }
    }
  }
  if (result.exported > 0) {
    await writeExportState(options, state);
  }
  return result;
}
