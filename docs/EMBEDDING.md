# 嵌入指南

宿主应用需要负责四类输入：

```text
1. 模型配置
2. runtime home
3. 权限交互
4. 事件渲染
```

## 版本握手

宿主启动 Agent runtime 前先读取公开能力快照，不要从 npm package version 猜测协议：

```ts
import { getAgentCoreRuntimeCapabilities } from '@mllo/agent-core'

const capabilities = getAgentCoreRuntimeCapabilities()
if (capabilities.runtimeContractVersion !== 1) {
  throw new Error(`Unsupported Agent Core runtime contract: ${capabilities.runtimeContractVersion}`)
}
```

快照还包含 `queryEventSchemaVersion`、`interactionSchemaVersion` 和 `stateSchemaVersion`。如果已有 `state.sqlite` 来自更新的 Core，打开时会抛出 `MlloStateSchemaVersionError`，旧 Core 不会尝试修改该数据库。

## 1. 模型配置

```ts
const provider = {
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'local-key',
  model: 'local-model'
} as const
```

`protocol` 当前支持：

```text
openai
anthropic
```

## 2. Runtime Home

宿主应用必须明确传入 `session.configDir` 和 `session.stateDbPath`。

```ts
session: {
  configDir: `${home}/.mllo`,
  stateDbPath: `${home}/.mllo/state.sqlite`
}
```

不要让 core 猜宿主应用的数据目录。这样 CLI、GUI、server 可以共享一个状态目录，也可以完全隔离。

## 3. 权限交互

权限请求从 controller 抛给宿主应用：

```ts
onPermissionRequest: async (request, { interactionId }) => {
  showPendingPermission(interactionId, request)
  return {
    status: 'allow'
  }
}
```

真实产品里应该把 `request.decision.reason`、`request.call.name`、`request.call.input` 展示给用户，并允许保存规则。

### 3.1 进程重启后的 pending interaction

不提供 callback 时，controller 返回 `waiting-for-permission` 或
`waiting-for-elicitation`，对应 request 已经同时写入 JSONL 和 SQLite。宿主重启后可以重新打开
state store，列出并提交 resolution：

```ts
import {
  AgentCoreJsonlSessionStore,
  MlloStateStore,
  listPendingAgentCoreInteractions,
  submitAgentCoreInteractionResolution,
} from '@mllo/agent-core'

const stateStore = new MlloStateStore({ dbPath: `${home}/.mllo/state.sqlite` })
const sessionStore = new AgentCoreJsonlSessionStore({ configDir: `${home}/.mllo` })

const pending = listPendingAgentCoreInteractions({ stateStore })
const interaction = pending[0]
if (interaction?.kind === 'elicitation') {
  const outcome = await submitAgentCoreInteractionResolution({
    stateStore,
    sessionStore,
    interactionId: interaction.id,
    resolution: {
      kind: 'elicitation',
      decision: { status: 'answer', answer: 'A' }
    }
  })
  console.log(outcome.status)
}
```

返回状态为 `resolved`、`already-resolved`、`conflict`、`invalid-resolution` 或
`not-found`。resolution 是持久化的用户决定，不是 exactly-once 执行凭证；特别是 permission
`allow`，进程重启后不会自动重放工具。宿主完成恢复流程后应关闭 `stateStore`。
如果 SQLite 投影缺失或落后，可调用 `reindexMlloState({ configDir, stateDbPath, reset: true })`
从 session JSONL 重建 pending/resolved 当前态。

## 4. 事件渲染

`runAgentCoreController()` 是 async generator。

```ts
for await (const event of runAgentCoreController(options)) {
  render(event)
}
```

宿主应用可以把事件渲染成 CLI 输出、GUI timeline、日志或远程 WebSocket。

## 5. 外部 worker

外部 worker 通过统一接口接入：

```ts
const worker = {
  id: 'reviewer',
  label: 'Reviewer',
  description: 'Review code and report risks.',
  capabilities: ['review'],
  async run(request) {
    return {
      content: `Reviewed: ${request.prompt}`
    }
  }
}
```

core 不关心 worker 内部是本地进程、远程服务还是另一个模型循环。

## 6. MCP

如果宿主应用要启用 MCP，可以：

```ts
const clients = await readAgentCoreMcpClientsFromConfig({
  cwd: projectPath
})
```

默认查找 `.mcp.json`。如果需要其他路径，传入 `candidates`。

## 7. 调试 prompt

默认不开启完整 prompt dump。

```bash
MLLO_DUMP_PROMPTS=1
```

启用后写入：

```text
~/.mllo/dump-prompts/<session-id>.jsonl
```

这个文件适合排查模型协议、工具 schema、上下文膨胀和流式响应问题。

## 8. 宿主领域工具

桌面端、内容系统或服务端可以把自己的领域能力注入同一个 Query Loop：

```ts
runAgentCoreController({
  // 保留文件、Shell、Skills 等默认工具。
  includeBaseTools: true,
  additionalTools: [contentSearchTool, contentOrganizeTool],
  additionalSystemPromptBlocks: [contentProductPolicy],
  toolExposureMode: 'direct',
  // 省略其他运行参数。
})
```

纯领域 Agent 可以设置 `includeBaseTools: false`，只暴露宿主传入的工具。Core 会拒绝同名工具，避免宿主静默覆盖默认工具的权限或实现。

宿主产品策略使用 `additionalSystemPromptBlocks` 注入。每个 block 都要使用唯一名称并声明 cache scope；Core 会把它和基础策略一起写入 session snapshot，恢复会话时不从当前宿主环境重新猜测。
