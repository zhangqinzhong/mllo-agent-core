import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { appendMlloExternalTraceRecord } from "./mllo-external-trace-jsonl";
import {
  summarizeAnthropicMessageRequest,
  summarizeAnthropicMessageResponse,
} from "./mllo-anthropic-message-trace";
import type {
  MlloAnthropicTraceProxyHandle,
  MlloAnthropicTraceProxyOptions,
  MlloExternalTraceRecord,
} from "./mllo-external-trace-types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 43111;
const DEFAULT_UPSTREAM_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MAX_BUFFERED_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CAPTURED_RESPONSE_BYTES = 8 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function getListenUrl(serverAddress: AddressInfo | string | null, host: string): string {
  if (serverAddress === null || typeof serverAddress === "string") {
    return `http://${host}:${DEFAULT_PORT}`;
  }
  return `http://${host}:${serverAddress.port}`;
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function formatError(error: unknown): { name?: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    message: String(error),
  };
}

function toHeaderRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      record[key] = value;
    }
  }
  return record;
}

function toForwardHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || value === undefined) {
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`request body exceeds trace proxy limit (${maxBytes} bytes)`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function appendCapturedChunk(args: {
  chunks: Buffer[];
  chunk: Buffer;
  capturedBytes: number;
  maxCapturedBytes: number;
}): { capturedBytes: number; truncated: boolean } {
  const remainingBytes = args.maxCapturedBytes - args.capturedBytes;
  if (remainingBytes <= 0) {
    return {
      capturedBytes: args.capturedBytes,
      truncated: true,
    };
  }
  const captured =
    args.chunk.byteLength <= remainingBytes ? args.chunk : args.chunk.subarray(0, remainingBytes);
  args.chunks.push(captured);
  return {
    capturedBytes: args.capturedBytes + captured.byteLength,
    truncated: captured.byteLength < args.chunk.byteLength,
  };
}

function buildUpstreamUrl(request: IncomingMessage, upstreamBaseUrl: string): URL {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const upstream = new URL(upstreamBaseUrl);
  const upstreamPath = upstream.pathname.replace(/\/$/, "");
  const requestPath = requestUrl.pathname.replace(/^\//, "");
  upstream.pathname = `${upstreamPath}/${requestPath}`.replace(/\/{2,}/g, "/");
  upstream.search = requestUrl.search;
  return upstream;
}

function isTraceableAnthropicMessagesRequest(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  return request.method === "POST" && pathname === "/v1/messages";
}

async function pipeUpstreamResponse(args: {
  upstreamResponse: Response;
  response: ServerResponse;
  maxCapturedResponseBytes: number;
}): Promise<{ body: Buffer; truncated: boolean }> {
  args.response.writeHead(
    args.upstreamResponse.status,
    args.upstreamResponse.statusText,
    toHeaderRecord(args.upstreamResponse.headers),
  );
  if (args.upstreamResponse.body === null) {
    args.response.end();
    return {
      body: Buffer.alloc(0),
      truncated: false,
    };
  }
  const reader = args.upstreamResponse.body.getReader();
  const capturedChunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = Buffer.from(result.value);
      args.response.write(chunk);
      const capture = appendCapturedChunk({
        chunks: capturedChunks,
        chunk,
        capturedBytes,
        maxCapturedBytes: args.maxCapturedResponseBytes,
      });
      capturedBytes = capture.capturedBytes;
      truncated = truncated || capture.truncated;
    }
  } finally {
    args.response.end();
    reader.releaseLock();
  }
  return {
    body: Buffer.concat(capturedChunks),
    truncated,
  };
}

export async function startMlloAnthropicTraceProxy(
  options: MlloAnthropicTraceProxyOptions = {},
): Promise<MlloAnthropicTraceProxyHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const upstreamBaseUrl = options.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL;
  const server = createServer((request, response) => {
    void handleProxyRequest(request, response, {
      ...options,
      upstreamBaseUrl,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    url: getListenUrl(server.address(), host),
    upstreamBaseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<Pick<MlloAnthropicTraceProxyOptions, "upstreamBaseUrl">> &
    MlloAnthropicTraceProxyOptions,
): Promise<void> {
  if (request.url === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      upstreamBaseUrl: options.upstreamBaseUrl,
    });
    return;
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const traceId = randomUUID();
  const upstreamUrl = buildUpstreamUrl(request, options.upstreamBaseUrl);
  let body: Buffer;
  try {
    body = await readRequestBody(
      request,
      options.maxBufferedRequestBytes ?? DEFAULT_MAX_BUFFERED_REQUEST_BYTES,
    );
  } catch (error) {
    sendJson(response, 413, {
      error: "trace_proxy_request_too_large",
      message: formatError(error).message,
    });
    return;
  }
  const traceable = isTraceableAnthropicMessagesRequest(request);
  const requestSummary = summarizeAnthropicMessageRequest({
    method: request.method ?? "GET",
    pathname: upstreamUrl.pathname,
    body,
    captureBodies: options.captureBodies,
    redactSecrets: options.redactSecrets,
  });

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: toForwardHeaders(request),
      body:
        request.method === "GET" || request.method === "HEAD" ? undefined : body.toString("utf8"),
    });
    const captured = await pipeUpstreamResponse({
      upstreamResponse,
      response,
      maxCapturedResponseBytes:
        options.maxCapturedResponseBytes ?? DEFAULT_MAX_CAPTURED_RESPONSE_BYTES,
    });
    if (traceable) {
      await appendMlloExternalTraceRecord(
        {
          type: "external_trace",
          schemaVersion: 1,
          id: traceId,
          source: "anthropic",
          protocol: "anthropic",
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          upstreamUrl: upstreamUrl.toString(),
          request: requestSummary,
          response: summarizeAnthropicMessageResponse({
            statusCode: upstreamResponse.status,
            contentType: upstreamResponse.headers.get("content-type") ?? undefined,
            body: captured.body,
            captureBodies: options.captureBodies,
            redactSecrets: options.redactSecrets,
            truncatedBody: captured.truncated,
          }),
        },
        {
          homePath: options.homePath,
        },
      );
    }
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, 502, {
        error: "trace_proxy_upstream_error",
        message: formatError(error).message,
      });
    } else {
      response.end();
    }
    if (traceable) {
      const record: MlloExternalTraceRecord = {
        type: "external_trace",
        schemaVersion: 1,
        id: traceId,
        source: "anthropic",
        protocol: "anthropic",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        upstreamUrl: upstreamUrl.toString(),
        request: requestSummary,
        error: formatError(error),
      };
      await appendMlloExternalTraceRecord(record, {
        homePath: options.homePath,
      });
    }
  }
}
