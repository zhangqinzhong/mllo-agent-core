# mllo Agent Core

mllo Agent Core 是一个 TypeScript 写的 agent runtime core。

它不包含桌面 UI、Electron 壳、浏览器面板或任何宿主应用代码。它只负责 agent 的核心执行链路：

- 模型协议适配：支持 OpenAI-compatible 和 Anthropic-compatible HTTP 协议。
- Query Loop：多轮模型调用、工具调用、工具结果回灌、停止和恢复。
- 工具系统：文件读写、grep/glob、shell、计划、工作流、用户询问、外部 worker 委托。
- 权限系统：路径边界、shell 风险解释、危险命令拦截、权限请求事件。
- Session：JSONL transcript、索引、resume、thread metadata、文件历史。
- Context：系统提示词、项目说明、memory、skills、MCP、shell/workflow 状态注入。
- Budget：上下文预算、compact、工具结果裁剪、文件变更摘要。
- MCP：stdio、HTTP、SSE / Streamable HTTP client。
- Hooks：session、tool、permission、compact、cwd、file change 等生命周期扩展点。
- Runtime state：SQLite 状态索引，避免 GUI 或 CLI 反复扫描 JSONL。

## 边界

这个包刻意不做这些事：

- 不提供 React / Vue / Electron UI。
- 不绑定某个模型服务商。
- 不绑定某个外部 agent 产品。
- 不内置云端账号系统。
- 不替宿主应用决定权限 UI 怎么展示。
- 不替宿主应用决定产品形态。

宿主应用应该把它当成一个“agent 内核”：

```text
Host App / CLI / Server
        |
        v
mllo Agent Core
        |
        +-- Model Adapter
        +-- Tools
        +-- Session Store
        +-- Permissions
        +-- MCP Clients
        +-- Hooks
```

## 安装

```bash
npm install @mllo/agent-core
```

当前仓库本地开发：

```bash
npm install
npm run typecheck
npm run build
```

## 最小用法

```ts
import { runAgentCoreController } from '@mllo/agent-core'

for await (const event of runAgentCoreController({
  cwd: process.cwd(),
  input: '检查当前项目并总结结构',
  modelProvider: {
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'local-key',
    model: 'local-model'
  },
  session: {
    configDir: `${process.env.HOME}/.mllo`,
    stateDbPath: `${process.env.HOME}/.mllo/state.sqlite`
  }
})) {
  console.log(event)
}
```

实际宿主应用通常还会传入：

- `onPermissionRequest`
- `onElicitationRequest`
- `workers`
- `mcpClients`
- `hooks`
- `budget`
- 自定义 `fetchImpl`
- 自定义 shell execution backend

## Runtime Home

默认运行态目录建议放在：

```text
~/.mllo
```

常见内容：

```text
config.json
history.jsonl
session_index.jsonl
state.sqlite
projects/
sessions/
archived_sessions/
memories/
skills/
dump-prompts/
```

`dump-prompts` 默认不启用。需要调试每轮真实 request/response 时，设置：

```bash
MLLO_DUMP_PROMPTS=1
```

这会写入：

```text
~/.mllo/dump-prompts/<session-id>.jsonl
```

注意：这里可能包含完整 prompt、工具 schema、路径和隐私上下文，只适合本地调试。

## 开源版清洁原则

这个仓库只保留 mllo Agent Core 自身的抽象、协议和实现。

- 代码注释可以保留中文，因为很多实现约束需要解释“为什么”。
- 文档不引用其他 agent 产品作为卖点或来源。
- 测试 fixture 和示例使用通用 worker/model 名称。
- 第三方模型只以协议类型出现，例如 `openai`、`anthropic`。

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [嵌入指南](docs/EMBEDDING.md)
- [发布前检查](docs/OPEN_SOURCE_CHECKLIST.md)
