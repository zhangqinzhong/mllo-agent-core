# Runtime Contract

mllo Agent Core 应该是唯一的 agent runtime 源码。CLI、桌面端、服务端或其他宿主应用只消费这个包，不应该复制一份 core 再各自演化。

这份文档定义宿主应用和 core 之间必须保持稳定的协议边界。

## Source of Truth

```text
mllo-agent-core
  ├─ query loop
  ├─ tools
  ├─ permissions
  ├─ sessions
  ├─ runtime state
  ├─ MCP
  ├─ hooks
  └─ worker adapters

host application
  ├─ UI
  ├─ IPC / HTTP / WebSocket
  ├─ account or product state
  ├─ workspace selection
  └─ event rendering
```

宿主应用可以决定界面、窗口、IPC、配置入口和权限弹窗，但不能重新定义 agent core 的事实格式。

## Stable Contracts

以下内容变更时必须视为协议变更，并配套迁移或兼容层。

### 1. Query Events

`AgentCoreQueryEvent` 是 UI、CLI、observer、测试和日志共同消费的 timeline 协议。

新增事件类型时必须：

- 保持已有事件字段向后兼容。
- 为新事件补测试。
- 明确宿主应用在未知事件下可以安全忽略。

### 2. Session Transcript

JSONL transcript 是会话事实来源。

稳定要求：

- 每行一个完整 JSON entry。
- entry 必须带 `kind`、`uuid`、`timestamp`、`sessionId`、`cwd`。
- 新增 `kind` 时必须保证旧 reader 能跳过或保留未知 entry。
- `state.sqlite` 和 side index 都是派生索引，不能替代 transcript。

### 3. Runtime State

`state.sqlite` 用来快速读取当前态，不是长期事实库。

稳定要求：

- 表结构变更必须走 schema version。
- GUI 只能把它当索引；损坏时应能从 JSONL reindex。
- thread、task、team、worker tool event 的语义要和 transcript entry 对齐。

### 4. Prompt Dumps

`dump-prompts/<session-id>.jsonl` 是显式调试日志。

稳定要求：

- 默认关闭。
- 开启后记录 init/system_update/message/response。
- 不混进主 transcript。
- observer 展示前必须脱敏常见 secret 字段。

### 5. Permissions

权限决策由 core 产生，用户交互由宿主应用完成。

稳定要求：

- `allow`、`ask`、`deny` 的语义不能漂移。
- workspace roots 是文件工具的硬边界。
- shell 风险解释必须能被 UI 原样展示。
- 保存规则只能保存明确可解释的规则，不能保存含混输入。

### 6. Workers

外部 agent 通过 `AgentCoreWorker` 接入。

稳定要求：

- worker event 必须能进入同一条 timeline。
- worker 内部 tool use/result 必须可审计。
- worker permission request 必须走宿主应用统一审批。
- worker adapter 不能把第三方产品语义泄漏成 core 的主协议。

### 7. Tool Calls

工具调用由 core 负责解析、去重、校验、执行和回灌结果。

稳定要求：

- tool call id 只用于配对结果；重复检测必须按工具名和 JSON 参数判断。
- 同一轮复用 tool call id 时必须改写成唯一 id，并保留原始 id 的 repair metadata，不能静默复用。
- tool result 必须能和 assistant tool call 配对；compact、resume 和 rewind 类逻辑不能切断配对。
- schema validation 和 malformed arguments 必须回灌给模型修复，不能静默执行。
- schema validation feedback 必须包含校验问题、收到的参数预览和期望 schema 预览，帮助模型下一轮直接修正。
- 仅允许白名单参数别名自动修复；修复必须写入 metadata，不能覆盖已经存在的 canonical 参数。
- 未知工具名必须以 tool_result 形式回灌修复建议；可以建议别名或相似工具，但不能自动执行未注册名称。
- 同一 autonomous loop 内已失败的同名同参工具调用再次出现时必须生成 repeated-failure，而不是再次执行。
- 流式预执行只允许用于工具名已确定、参数 JSON 可信、且工具声明并发安全的调用。
- 截断 JSON 的修复可以保留为执行候选，但不能在模型 turn 完全结束前预执行。

### 8. Runtime Home

core 不猜宿主应用的数据目录。宿主应用必须显式传入 runtime home 或 session config。

稳定要求：

- `~/.mllo` 只是默认 CLI 目录。
- 桌面端、服务端、测试都可以注入不同 home。
- session 级 runtime 文件不能和同项目其他 session 串线。

## Change Rules

允许自由修改：

- 内部实现细节。
- observer 页面样式。
- token 估算策略。
- provider adapter 的内部 wire 解析。
- 测试 fixture。

需要兼容处理：

- event 类型和字段。
- transcript entry kind。
- SQLite schema。
- tool schema。
- permission decision。
- worker event。
- prompt dump entry type。

不应该在宿主应用里复制：

- query loop。
- tool runner。
- permission policy。
- session store。
- model adapter。
- compact/resume 逻辑。

## Recommended Integration

宿主应用应该通过依赖使用 core：

```text
host app
  -> import { runAgentCoreController } from '@mllo/agent-core'
  -> consume AgentCoreQueryEvent
  -> render UI
  -> answer permission / elicitation requests
```

如果宿主应用需要新增能力，优先把能力做成：

- core tool
- worker adapter
- MCP tool
- hook
- middleware

只有 UI、IPC、产品流程才应该留在宿主应用层。
