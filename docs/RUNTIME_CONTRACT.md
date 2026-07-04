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
- 继续最近会话必须优先使用 `state.sqlite` 的 thread 当前态，缺失或损坏时再退回 `session_index.jsonl`，不能要求宿主应用全量扫描 transcript。
- 每次追加新的 query loop message 后，必须追加带 `messageCount` 的 `budget-event` 检查点；resume 必须暴露最新检查点和实际恢复 message 数的差异，方便发现裁剪、compact 或中断导致的上下文漂移。

### 2.1 Input History

`history.jsonl` 是交互输入历史，不是会话事实来源。

稳定要求：

- 追加写入必须带 `sessionId`、`cwd` 和原始 `input`。
- CLI/GUI 用于展示历史时必须反向读取、按 `cwd` 过滤，并支持当前 session 优先。
- 交互历史 listing 必须跳过坏行；严格审计 reader 可以继续报错。
- 语义撤销必须追加 `input-retraction` tombstone。比如中断恢复或用户 undo 让某次提交不再代表真实意图时，交互 listing 必须隐藏被撤销输入，审计 reader 必须保留原始记录和撤销记录。
- 大历史文件不能要求宿主应用整文件读入内存。

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

### 4.1 External Traces

`external-traces/<source>.jsonl` 是 observer 捕获外部 agent 或外部宿主进程流量的事实记录。

稳定要求：

- 默认不开启本地代理；宿主或 CLI 必须显式打开。
- trace proxy 必须透传请求，不能参与 agent 决策。
- trace proxy 至少应覆盖 Anthropic `/v1/messages`、OpenAI-compatible `/v1/chat/completions` 和 OpenAI Responses `/v1/responses`。
- 默认只保存请求/响应摘要；保存 body 必须由用户显式开启。
- 写入前和展示前都必须脱敏常见 secret 字段。
- external trace 不能混进 session transcript，也不能进入模型上下文。

### 4.2 Project Instructions

`AGENTS.md` 是项目指令文件，由 core 负责发现并注入 prompt context。`AGENTS.override.md` 是同目录本地覆盖文件，优先级高于 `AGENTS.md`。

稳定要求：

- 对当前 `cwd`，必须从所属 workspace root 到当前目录逐层读取 `AGENTS.md`，越靠近 `cwd` 的规则越后出现。
- 同一目录存在 `AGENTS.override.md` 时，只加载覆盖文件，不再加载同目录的 `AGENTS.md`。
- 项目指令加载必须有总字节预算；超过预算时必须截断并暴露 `includedBytes`、`originalBytes` 和 `truncated` 状态。
- 发现过程不能越过 workspace root，避免父目录规则泄漏到无关项目。
- 额外 workspace root 不在当前 `cwd` 祖先链上时，只读取该 root 自身的 `AGENTS.md`。
- 写类文件工具在修改目标路径前，必须检查目标文件额外适用但尚未出现在当前 prompt context 里的 `AGENTS.md`；发现后本次不能写文件，必须把规则回灌给模型并要求重试。
- 宿主应用不能绕过 core 自行拼接项目规则；否则 CLI、桌面端和服务端会看到不同上下文。

### 5. Permissions

权限决策由 core 产生，用户交互由宿主应用完成。

稳定要求：

- `allow`、`ask`、`deny` 的语义不能漂移。
- permission resume 继续执行同一 assistant turn 时，如果后续工具再次触发权限请求，必须再次返回 `waiting-for-permission`，不能把它伪造成普通 `tool_result`。
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
- 工具定义的 `maxResultSizeChars` 是持久化阈值，不是 runner 级硬截断；超过阈值时必须先保留完整输出，再生成模型可见 preview 和 blob 引用。
- 同一 assistant turn 的所有 `tool_result` 必须共享总输出预算，避免多个工具结果各自不过限但合计打爆下一轮上下文。
- 当 runtime 提供 blob store 时，被共享预算裁剪的 `tool_result` 必须保留 `outputBlobPath` 和 `outputBlobBytes`，并在模型可见正文中渲染 `<mllo_persisted_tool_output>` 块；完整输出不能静默丢失。
- 每轮工具批次完成后可以产生 `tool-batch-summary` timeline event；默认应调用 summary model 生成短 label，失败时降级到确定性 label；event 只能保存 label、tool id/name、状态、错误类别和截断/blob 元数据，不能复制原始 tool input 或 output。
- 每次 query loop 决定再次进入模型调用时必须产生 `continue` timeline event，并用 `continuation.reason` 区分 `next_turn`、`stop_hook_blocking`、`reactive_compact_retry`、permission/elicitation resume 等路径；宿主 UI 可以忽略该事件，但 JSONL/observer 必须保留它。
- 同一 autonomous loop 内已失败的同名同参工具调用再次出现时必须生成 repeated-failure，而不是再次执行。
- 权限拒绝必须写成带错误分类的 tool_result；即使 run 进入 denied 终态，也不能留下未闭合的 tool call。
- query loop 入口和 session resume 都必须修复缺失或错位的 tool_result，不能把悬空 tool_call 发送给模型端点。
- indexed session resume 必须恢复连续 tail；按预算裁剪时不能跳过中间消息后再恢复更早消息。
- fallback JSONL session resume 也必须暴露被省略的 entry 数量；没有 side index 的旧会话不能让模型误以为 head/tail 窗口就是完整历史。
- compact 保留最近 tail 时不能切断 assistant tool_call、对应 tool_result 和紧随其后的 assistant 回复轨迹。
- indexed session resume 也不能切断 assistant tool_call、对应 tool_result 和紧随其后的 assistant 回复轨迹。
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
- observer API 内部展示方式。
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
