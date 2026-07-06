import type {
  AgentCoreLangfuseCaptureContent,
  AgentCoreLangfuseTracingOptions,
} from "./agent-core-langfuse-options";
import { maskAgentCoreLangfuseSensitiveData } from "./agent-core-langfuse-redaction";

type AgentCoreLangfuseSpanProcessor = {
  forceFlush: () => Promise<void>;
};

type AgentCoreLangfuseNodeSdk = {
  start: () => void;
  shutdown: () => Promise<void>;
};

export type ResolvedAgentCoreLangfuseTracing = {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  environment?: string;
  release?: string;
  userId?: string;
  sessionId?: string;
  traceName: string;
  tags: readonly string[];
  metadata: Record<string, string>;
  captureContent: AgentCoreLangfuseCaptureContent;
  flushOnEnd: boolean;
  initializeSdk: boolean;
  mask?: AgentCoreLangfuseTracingOptions["mask"];
};

let runtime:
  | {
      key: string;
      sdk: AgentCoreLangfuseNodeSdk;
      processor: AgentCoreLangfuseSpanProcessor;
    }
  | undefined;

function stringFromEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function normalizeCaptureContent(value: unknown): AgentCoreLangfuseCaptureContent | undefined {
  return value === "none" || value === "summary" || value === "full" ? value : undefined;
}

function toMetadataStrings(
  metadata: AgentCoreLangfuseTracingOptions["metadata"],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === undefined) {
      continue;
    }
    result[key] = String(value).slice(0, 200);
  }
  return result;
}

export function resolveAgentCoreLangfuseTracing(
  options?: AgentCoreLangfuseTracingOptions,
): ResolvedAgentCoreLangfuseTracing | undefined {
  if (options?.enabled === false) {
    return undefined;
  }
  const publicKey = options?.publicKey ?? stringFromEnv("LANGFUSE_PUBLIC_KEY");
  const secretKey = options?.secretKey ?? stringFromEnv("LANGFUSE_SECRET_KEY");
  if (publicKey === undefined || secretKey === undefined) {
    if (options?.enabled === true) {
      throw new Error("Langfuse tracing requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.");
    }
    return undefined;
  }
  return {
    publicKey,
    secretKey,
    baseUrl:
      options?.baseUrl ?? stringFromEnv("LANGFUSE_BASE_URL") ?? stringFromEnv("LANGFUSE_HOST"),
    environment: options?.environment ?? stringFromEnv("LANGFUSE_TRACING_ENVIRONMENT"),
    release: options?.release ?? stringFromEnv("LANGFUSE_RELEASE"),
    userId: options?.userId,
    sessionId: options?.sessionId,
    traceName: options?.traceName ?? "mllo-agent-run",
    tags: ["mllo-agent-core", ...(options?.tags ?? [])],
    metadata: toMetadataStrings(options?.metadata),
    captureContent:
      options?.captureContent ??
      normalizeCaptureContent(stringFromEnv("MLLO_LANGFUSE_CAPTURE_CONTENT")) ??
      "full",
    flushOnEnd: options?.flushOnEnd ?? true,
    initializeSdk: options?.initializeSdk ?? true,
    mask: options?.mask,
  };
}

async function applyAgentCoreLangfuseMask(args: {
  data: unknown;
  mask?: AgentCoreLangfuseTracingOptions["mask"];
}): Promise<unknown> {
  const customMasked = args.mask === undefined ? args.data : await args.mask({ data: args.data });
  return maskAgentCoreLangfuseSensitiveData(customMasked);
}

export async function ensureAgentCoreLangfuseRuntime(
  config: ResolvedAgentCoreLangfuseTracing,
): Promise<void> {
  if (!config.initializeSdk) {
    return;
  }
  const key = JSON.stringify({
    publicKey: config.publicKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    release: config.release,
  });
  if (runtime?.key === key) {
    return;
  }
  if (runtime !== undefined) {
    throw new Error("Langfuse tracing runtime is already initialized with different settings.");
  }
  const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@langfuse/otel"),
  ]);
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    release: config.release,
    mediaUploadEnabled: false,
    mask: ({ data }) => applyAgentCoreLangfuseMask({ data, mask: config.mask }),
  });
  const sdk = new NodeSDK({
    serviceName: "mllo-agent-core",
    spanProcessors: [processor],
  });
  sdk.start();
  runtime = {
    key,
    sdk,
    processor,
  };
}

export async function flushAgentCoreLangfuseRuntime(): Promise<void> {
  await runtime?.processor.forceFlush();
}

export async function shutdownAgentCoreLangfuseRuntime(): Promise<void> {
  await runtime?.sdk.shutdown();
  runtime = undefined;
}
