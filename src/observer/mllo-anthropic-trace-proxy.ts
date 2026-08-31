import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { appendMlloExternalTraceRecord } from "./mllo-external-trace-jsonl";
import {
  summarizeAnthropicMessageRequest,
  summarizeAnthropicMessageResponse,
} from "./mllo-anthropic-message-trace";
import {
  buildMlloTraceProxyUpstreamUrl,
  formatMlloTraceProxyError,
  getMlloTraceProxyListenUrl,
  pipeMlloTraceProxyUpstreamResponse,
  readMlloTraceProxyRequestBody,
  sendMlloTraceProxyJson,
  toMlloTraceProxyFetchBody,
  toMlloTraceProxyForwardHeaders,
} from "./mllo-trace-proxy-http";
import type {
  MlloAnthropicTraceProxyHandle,
  MlloAnthropicTraceProxyOptions,
  MlloExternalTraceRecord,
} from "./mllo-external-trace-types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 43111;
const DEFAULT_UPSTREAM_BASE_URL = "https://api.anthropic.com";
const DEFAULT_SOURCE = "mllo";
const DEFAULT_MAX_BUFFERED_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CAPTURED_RESPONSE_BYTES = 8 * 1024 * 1024;

function isTraceableAnthropicMessagesRequest(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  return request.method === "POST" && pathname === "/v1/messages";
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
    url: getMlloTraceProxyListenUrl({
      serverAddress: server.address(),
      host,
      fallbackPort: DEFAULT_PORT,
    }),
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
    sendMlloTraceProxyJson(response, 200, {
      ok: true,
      upstreamBaseUrl: options.upstreamBaseUrl,
    });
    return;
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const traceId = randomUUID();
  const upstreamUrl = buildMlloTraceProxyUpstreamUrl({
    request,
    upstreamBaseUrl: options.upstreamBaseUrl,
  });
  let body: Buffer;
  try {
    body = await readMlloTraceProxyRequestBody(
      request,
      options.maxBufferedRequestBytes ?? DEFAULT_MAX_BUFFERED_REQUEST_BYTES,
    );
  } catch (error) {
    sendMlloTraceProxyJson(response, 413, {
      error: "trace_proxy_request_too_large",
      message: formatMlloTraceProxyError(error).message,
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
      headers: toMlloTraceProxyForwardHeaders(request),
      body: toMlloTraceProxyFetchBody(request.method, body),
    });
    const captured = await pipeMlloTraceProxyUpstreamResponse({
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
          source: options.source ?? DEFAULT_SOURCE,
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
      sendMlloTraceProxyJson(response, 502, {
        error: "trace_proxy_upstream_error",
        message: formatMlloTraceProxyError(error).message,
      });
    } else {
      response.end();
    }
    if (traceable) {
      const record: MlloExternalTraceRecord = {
        type: "external_trace",
        schemaVersion: 1,
        id: traceId,
        source: options.source ?? DEFAULT_SOURCE,
        protocol: "anthropic",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        upstreamUrl: upstreamUrl.toString(),
        request: requestSummary,
        error: formatMlloTraceProxyError(error),
      };
      await appendMlloExternalTraceRecord(record, {
        homePath: options.homePath,
      });
    }
  }
}
