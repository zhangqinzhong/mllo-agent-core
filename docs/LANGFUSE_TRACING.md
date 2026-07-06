# Langfuse Tracing

mllo Agent Core 内置 Langfuse v5 观测层，用 OpenTelemetry 导出 agent run 和模型调用。

## 开启方式

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

只要 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 存在，`runAgentCoreController()` 会自动开启 tracing。没有这两个变量时，代码路径保持 no-op。

也可以通过代码显式配置：

```ts
await runAgentCoreController({
  // ...
  observability: {
    langfuse: {
      enabled: true,
      userId: "local-user",
      tags: ["dev"],
      captureContent: "full",
    },
  },
});
```

## 采集内容

默认 `captureContent: "full"`，记录 system prompt、messages、工具描述和模型输出，方便本地调试完整请求。

也可以通过环境变量显式控制：

```bash
export MLLO_LANGFUSE_CAPTURE_CONTENT=full
```

可选值：

- `full`：默认，记录 system prompt、messages、工具描述和模型输出，适合本地复现。
- `summary`：只记录消息数量、工具名、token usage、模型名、协议、provider 等摘要。
- `none`：只记录结构、状态和 usage。

## Trace 结构

```text
mllo.agent.run                 agent observation
├─ model.stream / model.complete   generation observation
├─ model.stream / model.complete   generation observation
└─ ...
```

每个 generation 会写入：

- `model`
- `modelParameters`
- `usageDetails`
- provider/protocol metadata
- 按 `captureContent` 策略处理后的 input/output

## 外部 Agent Trace

Claude Code、Codex CLI 这类外部进程不运行在 mllo Agent Core 内部，不能直接被 core 的 model adapter 包住。它们通过本地 trace proxy 观测：

```text
external agent
  -> mllo trace proxy
  -> upstream model endpoint
  -> external-traces/<source>.jsonl
  -> Langfuse generation
```

mllo 自己的 trace proxy 默认 `source=mllo`；只有抓 Claude Code、Codex CLI 等外部进程时，才显式传 `--anthropic-trace-source claude-code` 或 `--openai-trace-source codex-cli`。

Claude Code 示例：

```bash
mllo observe \
  --anthropic-trace-proxy \
  --anthropic-trace-source claude-code \
  --trace-capture-bodies \
  --langfuse-export-external-traces
```

然后让 Claude Code 的 `ANTHROPIC_BASE_URL` 指向命令输出里的 proxy URL。

Codex CLI / OpenAI-compatible 示例：

```bash
mllo observe \
  --openai-trace-proxy \
  --openai-trace-source codex-cli \
  --trace-capture-bodies \
  --langfuse-export-external-traces
```

Langfuse 中的区分字段：

```text
traceName: external.<source>.run
tags: external-agent, <source>, anthropic-compatible | openai-compatible
metadata.source: claude-code | codex-cli | ...
metadata.protocol: anthropic | openai
metadata.proxy: mllo-trace-proxy
```

## 脱敏策略

导出前会统一脱敏：

- `apiKey`
- `authorization`
- `password`
- `secret`
- `token`
- `sk-*`
- `pk-lf-*`
- `sk-lf-*`
- `Bearer ...`

如果宿主还有自己的脱敏规则，可以传入：

```ts
observability: {
  langfuse: {
    mask: ({ data }) => customMask(data),
  },
}
```

自定义 `mask` 会先执行，随后仍会经过 mllo 的默认脱敏。

## SDK 初始化

默认由 Agent Core 初始化 `@opentelemetry/sdk-node` 和 `LangfuseSpanProcessor`。

如果宿主应用已经统一初始化 OpenTelemetry，可以关闭内置初始化：

```ts
observability: {
  langfuse: {
    initializeSdk: false,
  },
}
```

这种模式下，Agent Core 只创建 Langfuse observation，不负责 exporter。

## 进程退出

长期运行的桌面端可以只依赖批量 flush。短生命周期 CLI 在退出前可以主动清理：

```ts
await shutdownAgentCoreLangfuseRuntime();
```
