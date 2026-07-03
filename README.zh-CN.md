# mllo Agent Core

<p align="center">
  <strong>用于构建代码 Agent 的 TypeScript Runtime。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a>
  &nbsp;·&nbsp;
  <a href="./docs/ARCHITECTURE.md">架构说明</a>
  &nbsp;·&nbsp;
  <a href="./docs/EMBEDDING.md">嵌入指南</a>
  &nbsp;·&nbsp;
  <a href="./docs/RUNTIME_CONTRACT.md">Runtime Contract</a>
  &nbsp;·&nbsp;
  <a href="./LICENSE">MIT License</a>
</p>

mllo Agent Core 是代码 Agent 的运行时内核。它负责模型循环、工具执行、权限、会话、上下文构造、MCP、hooks、skills 和长任务状态。

它不是桌面应用、CLI 界面、聊天 UI、账号系统或云服务。你可以把它嵌入到自己的 GUI、CLI、服务端或自动化系统里。

## 能力

- **模型循环不绑定厂商。** 支持 OpenAI-compatible 和 Anthropic-compatible HTTP 协议，并统一成内部消息和工具调用结构。
- **工具执行 Runtime。** 内置文件读写、搜索、shell、计划、workflow、用户询问、worker 委托和 MCP 工具调用。
- **官方 worker adapter。** Claude SDK 和 Codex CLI 可以注册成 `AgentCoreWorker`，供 `delegate_agent` 和 `run_agent_workflow` 调度。
- **权限优先。** 提供路径边界、shell 风险解释、shell 规则保存，以及宿主应用驱动的审批事件。
- **持久会话。** JSONL transcript、session index、resume window、thread metadata、文件历史、worker event 和 compact record。
- **上下文管理。** 系统提示词、项目说明、memory、skills、MCP 状态、shell task、workflow 状态和上下文预算压缩。
- **MCP client。** 支持 stdio、HTTP、SSE 和 streamable HTTP。
- **生命周期 hooks。** 覆盖 session start、prompt submit、tool、permission、compact、cwd change 和 file change。
- **运行态索引。** 用 SQLite 存当前态，避免宿主应用反复扫描 transcript。

## 安装

这个包还没有发布到 npm。现在先从源码使用：

```sh
git clone <repo-url> mllo-agent-core
cd mllo-agent-core
npm install
npm run build
```

宿主项目开发时可以先用本地依赖：

```json
{
  "dependencies": {
    "@mllo/agent-core": "file:../mllo-agent-core"
  }
}
```

未来发布 npm 后计划使用这个包名：

```sh
npm install @mllo/agent-core
```

本地检查：

```sh
npm run typecheck
npm run build
```

## CLI

这个包现在带一个很薄的 CLI 外壳，底层仍然调用同一个 `runAgentCoreController()`。
从源码 build 后可以直接运行：

```sh
node dist/src/cli/mllo-cli.js config init
node dist/src/cli/mllo-cli.js -p "总结当前项目" --permission-mode auto-readonly
node dist/src/cli/mllo-cli.js chat
node dist/src/cli/mllo-cli.js observe
```

如果以后通过 npm 安装或本地 link，二进制命令名是 `mllo`：

```sh
mllo config path
mllo run "检查 package.json" --output-format stream-json
mllo run --continue "继续上一个任务"
mllo observe --port 43110
```

`text` 给人看，`json` 输出最终 run envelope，`stream-json` 每行输出一个事件，最后再输出最终 envelope。GUI 和 benchmark 可以用这个事件流做可观测性，不需要依赖桌面界面。
`--continue` 会恢复所选 `--cwd` 下最近的未归档会话，优先读
`state.sqlite`，缺失时退回 `session_index.jsonl`。
`mllo chat` 会预加载所选 `--cwd` 的输入历史，并把当前或恢复会话的 prompt
排在前面。

`mllo observe` 会启动一个只读本地 Web Observer，默认绑定
`127.0.0.1`。它读取 `state.sqlite`、`session_index.jsonl`、transcript
JSONL 和 `dump-prompts` 文件，用来查看 sessions、timeline、prompt dump、
tool events 和脱敏后的原始 JSON。它不会执行工具，也不会参与 agent 决策。

## 快速开始

```ts
import { runAgentCoreController } from '@mllo/agent-core'

for await (const event of runAgentCoreController({
  cwd: process.cwd(),
  input: '检查当前项目并总结结构。',
  modelProvider: {
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'local-key',
    model: 'local-model'
  },
  session: {
    configDir: `${process.env.HOME}/.mllo`,
    stateDbPath: `${process.env.HOME}/.mllo/state.sqlite`
  },
  onPermissionRequest: async (request) => {
    console.log('permission requested:', request.reason)
    return { status: 'allow' }
  }
})) {
  console.log(event)
}
```

`runAgentCoreController()` 是 async generator。宿主应用可以把事件渲染成 CLI 输出、GUI timeline、日志、WebSocket 消息或测试断言。

## 配置

可以直接传入 provider：

```ts
modelProvider: {
  protocol: 'anthropic',
  baseUrl: 'https://example.com',
  apiKey: process.env.MODEL_API_KEY!,
  model: 'agent-model',
  maxTokens: 4096,
  temperature: 0.1
}
```

也可以从 mllo config 文件加载：

```json
{
  "defaultProvider": "local-openai",
  "providers": [
    {
      "name": "local-openai",
      "protocol": "openai",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "apiKey": "local-key",
      "model": "local-model",
      "promptProfile": "local-compact"
    }
  ]
}
```

小上下文本地模型建议用 `promptProfile: "local-compact"`。大上下文模型可以使用默认 full profile。

## Claude / Codex Worker

根包仍然保持纯 core。worker adapter 通过子路径导出，宿主应用只加载自己需要的部分：

```ts
import { createClaudeSdkWorker } from '@mllo/agent-core/claude-sdk'
import { createCodexCliWorker } from '@mllo/agent-core/codex-cli'
import { runAgentCoreController } from '@mllo/agent-core'

const workers = [
  createClaudeSdkWorker(),
  createCodexCliWorker()
]

for await (const event of runAgentCoreController({
  cwd: process.cwd(),
  input: '让 Claude 审查方案，让 Codex 提交 patch。',
  modelProvider,
  session,
  workers,
  onWorkerPermissionRequest: async (request) => {
    console.log('worker permission:', request.workerId, request.reason)
    return { status: 'allow' }
  }
})) {
  console.log(event)
}
```

前置条件：

- `@mllo/agent-core/claude-sdk` 需要安装 `@anthropic-ai/claude-agent-sdk`。它是 optional peer dependency，所以只 import 根包不会强制加载 Claude SDK。
- `@mllo/agent-core/codex-cli` 需要本机 `PATH` 里有可用的 `codex` 命令；也可以创建 worker 时传入 `command` / `spawnImpl`。
- 两个 worker 的危险动作都会回到 mllo worker permission bridge，再决定是否允许 shell 或文件修改。

## Runtime Home

宿主应用应该明确传入运行态目录，不要让 core 猜路径：

```ts
session: {
  configDir: `${home}/.mllo`,
  stateDbPath: `${home}/.mllo/state.sqlite`
}
```

常见运行态文件：

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

## 可观测性

默认不落完整 prompt，因为里面可能包含私有路径、工具 schema、消息和模型响应。

本地调试时可以开启：

```sh
MLLO_DUMP_PROMPTS=1
```

输出位置：

```text
~/.mllo/dump-prompts/<session-id>.jsonl
```

这个文件适合排查模型协议、工具 schema 膨胀、上下文增长、流式响应错误和异常模型行为。

## 架构

```text
Host App / CLI / Server
        |
        v
runAgentCoreController()
        |
        +-- context builder
        +-- budget and compact
        +-- model adapter
        +-- query loop
        +-- tool runner
        +-- permission requests
        +-- session store
        +-- MCP clients
        +-- hooks and workers
```

core 不决定审批 UI 长什么样，不决定密钥放哪里，不决定默认使用哪个模型厂商，也不决定外层产品形态。

## 这个包不做什么

- 不提供终端 UI。
- 不提供 Electron 应用。
- 不提供托管 Agent 服务。
- 不绑定某个模型厂商。
- 不绑定某个外部代码 Agent。
- 不替代宿主产品自己的权限体验。

## 文档

- [架构说明](./docs/ARCHITECTURE.md)
- [嵌入指南](./docs/EMBEDDING.md)

## 协议

MIT。见 [LICENSE](./LICENSE)。
