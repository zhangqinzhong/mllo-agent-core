# 嵌入指南

宿主应用需要负责四类输入：

```text
1. 模型配置
2. runtime home
3. 权限交互
4. 事件渲染
```

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
onPermissionRequest: async (request) => {
  return {
    status: 'allow'
  }
}
```

真实产品里应该把 `request.reason`、`request.toolName`、`request.input` 展示给用户，并允许保存规则。

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
