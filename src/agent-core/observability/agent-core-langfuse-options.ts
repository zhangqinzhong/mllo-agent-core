export type AgentCoreLangfuseCaptureContent = "none" | "summary" | "full";

export type AgentCoreLangfuseMaskFunction = (args: { data: unknown }) => unknown | Promise<unknown>;

export type AgentCoreLangfuseTracingOptions = {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  environment?: string;
  release?: string;
  userId?: string;
  sessionId?: string;
  traceName?: string;
  tags?: readonly string[];
  metadata?: Record<string, string | number | boolean | undefined>;
  captureContent?: AgentCoreLangfuseCaptureContent;
  flushOnEnd?: boolean;
  initializeSdk?: boolean;
  mask?: AgentCoreLangfuseMaskFunction;
};
