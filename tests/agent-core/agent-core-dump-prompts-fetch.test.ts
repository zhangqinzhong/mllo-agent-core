import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMlloDumpPromptsPath } from "../../src/agent-core/runtime-home/mllo-home-paths";
import {
  clearMlloDumpPromptsState,
  createMlloDumpPromptsFetch,
  flushMlloDumpPromptWrites,
} from "../../src/agent-core/model/agent-core-dump-prompts-fetch";

type JsonRecord = Record<string, unknown>;

// 创建独立 runtime home，避免测试污染用户真实 ~/.mllo。
async function createHomePath(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "mllo-dump-prompts-"));
}

// 读取 JSONL dump entry，测试只关心结构，不依赖写入时的 timestamp。
async function readDumpEntries(filePath: string): Promise<JsonRecord[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

// 构造 JSON response fetch，模拟非流式模型接口。
function mockJsonFetch(body: unknown): typeof fetch {
  return vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      headers: {
        "content-type": "application/json",
      },
    });
  }) as unknown as typeof fetch;
}

// 构造 SSE response fetch，模拟流式模型接口。
function mockSseFetch(events: readonly string[]): typeof fetch {
  const body = `${events.map((event) => `data: ${event}\n\n`).join("")}data: [DONE]\n\n`;
  return vi.fn(async () => {
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
      },
    });
  }) as unknown as typeof fetch;
}

describe("createMlloDumpPromptsFetch", () => {
  afterEach(async () => {
    await flushMlloDumpPromptWrites();
    clearMlloDumpPromptsState();
  });

  it("does not write dump files unless MLLO_DUMP_PROMPTS is enabled", async () => {
    const homePath = await createHomePath();
    const fetchImpl = mockJsonFetch({
      ok: true,
    });
    const fetchWithDump = createMlloDumpPromptsFetch({
      homePath,
      sessionId: "session-one",
      fetchImpl,
      env: {},
    });

    await fetchWithDump("https://model.test/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-test",
        messages: [
          {
            role: "user",
            content: "你好",
          },
        ],
      }),
    });
    await flushMlloDumpPromptWrites();

    await expect(stat(getMlloDumpPromptsPath("session-one", { homePath }))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes init, input messages, and JSON response when enabled", async () => {
    const homePath = await createHomePath();
    const fetchImpl = mockJsonFetch({
      choices: [
        {
          message: {
            content: "收到",
          },
        },
      ],
    });
    const fetchWithDump = createMlloDumpPromptsFetch({
      homePath,
      sessionId: "session/two",
      fetchImpl,
      env: {
        MLLO_DUMP_PROMPTS: "1",
      },
    });

    await fetchWithDump("https://model.test/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-test",
        messages: [
          {
            role: "system",
            content: "你是 mllo。",
          },
          {
            role: "user",
            content: "你好",
          },
          {
            role: "assistant",
            content: "我会查看。",
          },
          {
            role: "tool",
            tool_call_id: "call-1",
            content: "file list",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "list_dir",
            },
          },
        ],
        stream: false,
      }),
    });
    await flushMlloDumpPromptWrites();

    const entries = await readDumpEntries(getMlloDumpPromptsPath("session/two", { homePath }));
    expect(entries.map((entry) => entry.type)).toEqual(["init", "message", "message", "response"]);
    expect(entries[0]?.data).toMatchObject({
      model: "deepseek-test",
      system_messages: [
        {
          role: "system",
          content: "你是 mllo。",
        },
      ],
    });
    expect(entries[1]?.data).toMatchObject({
      role: "user",
      content: "你好",
    });
    expect(entries[2]?.data).toMatchObject({
      role: "tool",
      content: "file list",
    });
    expect(entries[3]?.data).toMatchObject({
      choices: [
        {
          message: {
            content: "收到",
          },
        },
      ],
    });
  });

  it("deduplicates init data and only appends newly seen input messages", async () => {
    const homePath = await createHomePath();
    const fetchImpl = mockJsonFetch({
      ok: true,
    });
    const fetchWithDump = createMlloDumpPromptsFetch({
      homePath,
      sessionId: "session-three",
      fetchImpl,
      env: {
        MLLO_DUMP_PROMPTS: "true",
      },
    });
    const firstMessages = [
      {
        role: "user",
        content: "第一轮",
      },
    ];
    const secondMessages = [
      ...firstMessages,
      {
        role: "assistant",
        content: "继续",
      },
      {
        role: "user",
        content: "第二轮",
      },
    ];

    await fetchWithDump("https://model.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-compatible",
        system: "固定系统提示",
        messages: firstMessages,
        tools: [],
        stream: false,
      }),
    });
    await fetchWithDump("https://model.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-compatible",
        system: "固定系统提示",
        messages: secondMessages,
        tools: [],
        stream: false,
      }),
    });
    await flushMlloDumpPromptWrites();

    const entries = await readDumpEntries(getMlloDumpPromptsPath("session-three", { homePath }));
    expect(entries.map((entry) => entry.type)).toEqual([
      "init",
      "message",
      "response",
      "message",
      "response",
    ]);
    expect(entries.filter((entry) => entry.type === "message").map((entry) => entry.data)).toEqual([
      {
        role: "user",
        content: "第一轮",
      },
      {
        role: "user",
        content: "第二轮",
      },
    ]);
  });

  it("records streaming responses as parsed SSE chunks", async () => {
    const homePath = await createHomePath();
    const fetchImpl = mockSseFetch([
      '{"type":"message_start","message":{"id":"msg-1"}}',
      '{"type":"content_block_delta","delta":{"text":"你好"}}',
    ]);
    const fetchWithDump = createMlloDumpPromptsFetch({
      homePath,
      sessionId: "session-four",
      fetchImpl,
      env: {
        MLLO_DUMP_PROMPTS: "1",
      },
    });

    await fetchWithDump("https://model.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-compatible",
        system: "系统",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "你好",
              },
            ],
          },
        ],
        tools: [],
        stream: true,
      }),
    });
    await flushMlloDumpPromptWrites();

    const entries = await readDumpEntries(getMlloDumpPromptsPath("session-four", { homePath }));
    expect(entries.find((entry) => entry.type === "response")?.data).toEqual({
      stream: true,
      chunks: [
        {
          type: "message_start",
          message: {
            id: "msg-1",
          },
        },
        {
          type: "content_block_delta",
          delta: {
            text: "你好",
          },
        },
      ],
    });
  });

  it("can dump a cloned response after the caller consumes the original body", async () => {
    const homePath = await createHomePath();
    const fetchWithDump = createMlloDumpPromptsFetch({
      homePath,
      sessionId: "session-five",
      fetchImpl: mockJsonFetch({
        answer: "ok",
      }),
      env: {
        MLLO_DUMP_PROMPTS: "1",
      },
    });

    const response = await fetchWithDump("https://model.test/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-test",
        messages: [
          {
            role: "user",
            content: "先消费 body",
          },
        ],
      }),
    });
    await expect(response.json()).resolves.toEqual({
      answer: "ok",
    });
    await flushMlloDumpPromptWrites();

    const entries = await readDumpEntries(getMlloDumpPromptsPath("session-five", { homePath }));
    expect(entries.find((entry) => entry.type === "response")?.data).toEqual({
      answer: "ok",
    });
  });
});
