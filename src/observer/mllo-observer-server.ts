import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { handleMlloObserverApiRequest } from "./mllo-observer-api";
import { renderMlloObserverPage } from "./mllo-observer-page";
import { listMlloObserverSessions } from "./mllo-observer-sessions";
import type { MlloObserverOptions, MlloObserverServerHandle } from "./mllo-observer-types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 43110;
const DEFAULT_POLL_INTERVAL_MS = 2000;

function sendNotFound(response: ServerResponse): void {
  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Not found");
}

function sendPage(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(renderMlloObserverPage());
}

function sendSse(response: ServerResponse, eventName: string, data: unknown): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function getListenUrl(serverAddress: AddressInfo | string | null, host: string): string {
  if (serverAddress === null || typeof serverAddress === "string") {
    return `http://${host}:${DEFAULT_PORT}`;
  }
  return `http://${host}:${serverAddress.port}`;
}

export async function startMlloObserverServer(
  options: MlloObserverOptions = {},
): Promise<MlloObserverServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const clients = new Set<ServerResponse>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, options, clients);
  });
  const pollInterval = setInterval(() => {
    void broadcastSessions(options, clients);
  }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: getListenUrl(server.address(), host),
    close: async () => {
      clearInterval(pollInterval);
      for (const client of clients) {
        client.end();
      }
      clients.clear();
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

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: MlloObserverOptions,
  clients: Set<ServerResponse>,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/" || pathname === "/index.html") {
    sendPage(response);
    return;
  }
  if (pathname === "/events") {
    await openSse(response, options, clients);
    return;
  }
  if (await handleMlloObserverApiRequest(request, response, options)) {
    return;
  }
  sendNotFound(response);
}

async function openSse(
  response: ServerResponse,
  options: MlloObserverOptions,
  clients: Set<ServerResponse>,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  clients.add(response);
  response.on("close", () => {
    clients.delete(response);
  });
  sendSse(response, "ready", {
    ok: true,
  });
  await broadcastSessions(options, new Set([response]));
}

async function broadcastSessions(
  options: MlloObserverOptions,
  clients: Set<ServerResponse>,
): Promise<void> {
  if (clients.size === 0) {
    return;
  }
  try {
    const sessions = await listMlloObserverSessions({
      homePath: options.homePath,
      limit: 200,
    });
    for (const client of clients) {
      sendSse(client, "sessions", {
        sessions,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const client of clients) {
      sendSse(client, "error", {
        message,
      });
    }
  }
}
