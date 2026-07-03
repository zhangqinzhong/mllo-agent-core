# Contributing

mllo-agent-core 是 mllo 的唯一 Agent Core 源码基线。桌面端、CLI、观察页或其他宿主可以集成它，但不应该复制另一套 core。

## 本地环境

- Node.js `>=22.5.0`
- npm

安装依赖：

```bash
npm ci
```

提交前运行：

```bash
npm run verify
```

## 提交流程

本仓库采用“小 pre-commit，大 CI”的规则：

- `pre-commit` 只运行 `lint-staged`，用于拦截明显 lint 问题并格式化已暂存文件。
- CI 运行 `lint`、`typecheck`、`test`、`build`、npm 包内容检查和 CLI smoke test。
- `main` 分支应开启保护：禁止直接推送、禁止 force push、要求 CI 通过、至少一次 review。

## 代码边界

core 层只放运行时能力：

- model loop
- tools
- session / JSONL / checkpoint
- permissions
- MCP
- hooks
- skills
- observer
- provider adapters

宿主应用相关的 UI、品牌、窗口状态、Electron IPC 和私有产品配置不应该进入 core。

## 公开文档边界

`docs/` 是公开文档，只写可发布的 runtime、API、CLI、observer 和嵌入方式。

不要提交：

- 私有仓库路径
- 本机绝对路径
- 内部产品规划
- 临时审查结论
- `.env`
- JSONL 会话记录
- SQLite 状态库
- `notes/`

## Review Checklist

涉及下面任一项时，PR 必须说明兼容策略：

- 公开 API
- 事件协议
- 工具 schema
- 权限语义
- session / checkpoint / state 文件格式
- npm 包导出路径

安全相关变更必须说明：

- 哪些路径会被读取或写入
- shell 命令是否会扩大执行范围
- 是否会把 prompt、环境变量、token 或本地路径写入日志
