export type MlloExternalTraceProtocol = "anthropic" | "openai";

export type MlloExternalTraceSource = string;

export type MlloExternalTraceRequestSummary = {
  method: string;
  pathname: string;
  model?: string;
  stream?: boolean;
  messageCount?: number;
  systemBlockCount?: number;
  toolCount?: number;
  toolNames?: string[];
  bodyBytes: number;
  body?: unknown;
};

export type MlloExternalTraceResponseSummary = {
  statusCode?: number;
  contentType?: string;
  eventTypes?: string[];
  usage?: unknown;
  stopReason?: string;
  toolUseNames?: string[];
  bodyBytes?: number;
  bodyText?: string;
  body?: unknown;
  truncatedBody?: boolean;
};

export type MlloExternalTraceRecord = {
  type: "external_trace";
  schemaVersion: 1;
  id: string;
  source: MlloExternalTraceSource;
  protocol: MlloExternalTraceProtocol;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  upstreamUrl: string;
  request: MlloExternalTraceRequestSummary;
  response?: MlloExternalTraceResponseSummary;
  error?: {
    name?: string;
    message: string;
  };
};

export type MlloExternalTraceLogSummary = {
  source: MlloExternalTraceSource;
  path: string;
  fileBytes: number;
  updatedAtMs: number;
};

export type MlloExternalTraceJsonlOptions = {
  homePath?: string;
};

export type MlloExternalTraceLogReadOptions = MlloExternalTraceJsonlOptions & {
  source: MlloExternalTraceSource;
  maxEntries?: number;
  maxBytes?: number;
  redactSecrets?: boolean;
};

export type MlloAnthropicTraceProxyOptions = MlloExternalTraceJsonlOptions & {
  host?: string;
  port?: number;
  upstreamBaseUrl?: string;
  redactSecrets?: boolean;
  captureBodies?: boolean;
  maxBufferedRequestBytes?: number;
  maxCapturedResponseBytes?: number;
};

export type MlloAnthropicTraceProxyHandle = {
  url: string;
  upstreamBaseUrl: string;
  close: () => Promise<void>;
};

export type MlloOpenAITraceProxyOptions = MlloExternalTraceJsonlOptions & {
  host?: string;
  port?: number;
  upstreamBaseUrl?: string;
  redactSecrets?: boolean;
  captureBodies?: boolean;
  maxBufferedRequestBytes?: number;
  maxCapturedResponseBytes?: number;
};

export type MlloOpenAITraceProxyHandle = {
  url: string;
  upstreamBaseUrl: string;
  close: () => Promise<void>;
};
