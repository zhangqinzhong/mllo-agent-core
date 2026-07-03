# 架构说明

mllo Agent Core 分成九层。

```text
runtime/
  对外运行入口，串起配置、session、context、model、tools、permissions、hooks。

query-loop/
  模型调用循环。负责模型回复解析、工具调用状态机、工具结果回灌、停止和恢复。

model/
  HTTP 模型协议适配。当前支持 openai 与 anthropic 两类 wire protocol。

tools/
  内置工具和工具执行器。包括文件、搜索、shell、计划、workflow、用户询问、外部 worker。

permissions/
  shell 和路径权限判定。这里只给出风险、解释和决策请求，不绑定任何 UI。

context/
  系统提示词和运行上下文构造。包括项目说明、memory、skills、MCP、workflow、shell 状态。

session/
  JSONL transcript、窗口读取、resume、索引、thread metadata 和文件历史。

runtime-state/
  SQLite 状态索引。用于快速读取 thread、task、team、worker tool event 等当前态。

mcp/ hooks/ budget/ workers/
  MCP client、生命周期 hook、上下文预算、外部 worker 协议。
```

## 运行主链路

```text
runAgentCoreController()
  -> prepareRunSession()
  -> load config/provider/hooks
  -> create model adapter
  -> resolve MCP clients
  -> build context
  -> apply budget / compact
  -> run query loop
  -> record transcript and state
```

## Query Loop

Query Loop 只认识统一的内部消息结构：

```text
user
assistant
tool
```

模型协议差异由 `model/` 消化：

```text
AgentCoreMessage[] -> protocol request body -> protocol response -> AgentCoreModelResponse
```

这样工具、权限、session、context 都不需要知道底层模型协议。

## 工具执行

工具执行分三步：

```text
1. validate input
2. request permission when needed
3. execute and return tool result
```

工具结果会被规范化为：

```ts
type AgentCoreToolResult = {
  content: string
  isError?: boolean
  metadata?: unknown
}
```

大结果会被裁剪或落 blob，避免单次工具输出撑爆上下文。

## Session 边界

主 transcript 只存恢复运行需要的事实：

```text
session metadata
message
permission event
timeline event
worker tool event
thread state
budget event
compact record
checkpoint restore event
```

完整模型 request/response 不进入主 transcript。调试时使用 `dump-prompts`。

## 权限边界

core 只做三件事：

```text
1. 判断风险
2. 解释风险
3. 发出权限请求
```

最终 UI 交互、规则保存、组织策略，应由宿主应用决定。

## MCP 边界

MCP 支持：

```text
stdio
http
sse
streamable-http
```

默认只查找项目向上的 `.mcp.json`。宿主应用可以通过 `candidates` 传入自己的配置位置。

## Skills 边界

默认扫描：

```text
~/.mllo/skills
~/.agents/skills
<project>/.mllo/skills
<project>/.agents/skills
```

skill 只是 context 和工具能力的扩展来源，不和具体宿主 UI 绑定。
