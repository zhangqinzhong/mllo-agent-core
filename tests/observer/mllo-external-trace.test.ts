import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  listMlloExternalTraceLogs,
  type MlloExternalTraceLogSummary,
  readMlloExternalTraceLog,
  startMlloAnthropicTraceProxy,
} from "../../src/observer";

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
  return body;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForTraceLogs(homePath: string): Promise<MlloExternalTraceLogSummary[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const logs = await listMlloExternalTraceLogs({
      homePath,
    });
    if (logs.length > 0) {
      return logs;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return await listMlloExternalTraceLogs({
    homePath,
  });
}

describe("mllo external trace", () => {
  it("proxies Anthropic messages and stores a redacted trace record", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "mllo-external-trace-"));
    let upstreamBody = "";
    const upstream = createServer((request, response) => {
      void readBody(request).then((body) => {
        upstreamBody = body;
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: "read_file",
                input: {
                  path: "README.md",
                },
              },
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          }),
        );
      });
    });
    const upstreamUrl = await listen(upstream);
    const proxy = await startMlloAnthropicTraceProxy({
      homePath,
      port: 0,
      upstreamBaseUrl: upstreamUrl,
      captureBodies: true,
    });

    try {
      const response = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer abcdefghijklmnop",
        },
        body: JSON.stringify({
          model: "test-model",
          stream: false,
          apiKey: "secret-value",
          messages: [
            {
              role: "user",
              content: "hello",
            },
          ],
          tools: [
            {
              name: "read_file",
              input_schema: {
                type: "object",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        stop_reason: "tool_use",
      });
      expect(JSON.parse(upstreamBody)).toMatchObject({
        model: "test-model",
      });

      const logs = await waitForTraceLogs(homePath);
      expect(logs.map((log) => log.source)).toEqual(["anthropic"]);

      const trace = await readMlloExternalTraceLog({
        homePath,
        source: "anthropic",
        redactSecrets: true,
      });
      expect(trace.exists).toBe(true);
      expect(trace.entries).toHaveLength(1);
      const record = trace.entries[0]?.parsed as Record<string, unknown>;
      expect(record.request).toMatchObject({
        model: "test-model",
        messageCount: 1,
        toolCount: 1,
        toolNames: ["read_file"],
      });
      expect(record.response).toMatchObject({
        statusCode: 200,
        stopReason: "tool_use",
        toolUseNames: ["read_file"],
      });
      expect(trace.entries[0]?.json).toContain("[redacted]");
      expect(trace.entries[0]?.json).not.toContain("secret-value");
    } finally {
      await proxy.close();
      await closeServer(upstream);
    }
  });

  it("preserves an upstream base path when forwarding", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "mllo-external-trace-prefix-"));
    let upstreamPath = "";
    const upstream = createServer((request, response) => {
      upstreamPath = request.url ?? "";
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          id: "msg_2",
          type: "message",
          role: "assistant",
          content: [],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        }),
      );
    });
    const upstreamUrl = await listen(upstream);
    const proxy = await startMlloAnthropicTraceProxy({
      homePath,
      port: 0,
      upstreamBaseUrl: `${upstreamUrl}/anthropic`,
    });

    try {
      const response = await fetch(`${proxy.url}/v1/messages?beta=true`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [],
        }),
      });

      expect(response.status).toBe(200);
      expect(upstreamPath).toBe("/anthropic/v1/messages?beta=true");
    } finally {
      await proxy.close();
      await closeServer(upstream);
    }
  });
});
