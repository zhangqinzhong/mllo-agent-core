# mllo Agent Core

<p align="center">
  <strong>A TypeScript runtime for building coding agents.</strong>
</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="./docs/ARCHITECTURE.md">Architecture</a>
  &nbsp;·&nbsp;
  <a href="./docs/EMBEDDING.md">Embedding</a>
  &nbsp;·&nbsp;
  <a href="./docs/RUNTIME_CONTRACT.md">Runtime Contract</a>
  &nbsp;·&nbsp;
  <a href="./LICENSE">MIT License</a>
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-8b949e.svg?style=flat-square">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-5.9-3178c6.svg?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/Node.js-%3E%3D22.5-3c873a.svg?style=flat-square">
</p>

mllo Agent Core is the runtime layer behind a coding agent. It owns the model
loop, tool execution, permissions, sessions, context construction, MCP clients,
hooks, skills, and long-running workflow state.

It is deliberately not a desktop app, CLI shell, chat UI, account system, or
cloud service. Bring your own interface; use this package as the agent engine.

## Features

- **Provider-neutral model loop.** OpenAI-compatible and Anthropic-compatible
  HTTP providers are normalized into one internal message and tool-call model.
- **Tool execution runtime.** File reading, writing, search, shell commands,
  planning, workflows, user questions, worker delegation, and MCP tool calls.
- **Official worker adapters.** Claude SDK and Codex CLI can be registered as
  `AgentCoreWorker` instances for `delegate_agent` and `run_agent_workflow`.
- **Permission-first design.** Path guards, shell risk explanations, saved shell
  rules, and host-driven approval events are part of the core loop.
- **Durable sessions.** JSONL transcripts, session indexes, resume windows,
  thread metadata, file history, worker events, and compact records.
- **Context management.** System prompts, project instructions, memory, skills,
  MCP state, shell tasks, workflow state, and context budget collapse.
- **MCP client support.** stdio, HTTP, SSE, and streamable HTTP transports.
- **Extensible hooks.** Lifecycle hooks around session start, prompt submit,
  tools, permissions, compaction, cwd changes, and file changes.
- **Runtime state index.** SQLite-backed state avoids repeatedly scanning
  transcripts in host apps.

## Install

This package is not published to npm yet. For now, use it from source:

```sh
git clone <repo-url> mllo-agent-core
cd mllo-agent-core
npm install
npm run build
```

In a host project, depend on the local checkout while developing:

```json
{
  "dependencies": {
    "@mllo/agent-core": "file:../mllo-agent-core"
  }
}
```

Planned npm package name after publication:

```sh
npm install @mllo/agent-core
```

Local checks:

```sh
npm run typecheck
npm run build
```

## CLI

The package now includes a thin CLI wrapper around the same runtime controller.
After building from source, run it directly:

```sh
node dist/src/cli/mllo-cli.js config init
node dist/src/cli/mllo-cli.js -p "summarize this project" --permission-mode auto-readonly
node dist/src/cli/mllo-cli.js chat
node dist/src/cli/mllo-cli.js observe
```

When installed or linked as a package, the binary name is `mllo`:

```sh
mllo config path
mllo run "inspect package.json" --output-format stream-json
mllo run --continue "continue the previous task"
mllo observe --port 43110
```

`text` output is for humans, `json` emits one final run envelope, and
`stream-json` emits one JSON event per line plus the final envelope. This gives
host apps and benchmarks a stable observability path without depending on a UI.
`--continue` resumes the latest non-archived session for the selected `--cwd`
using `state.sqlite` first and `session_index.jsonl` as a fallback.
`mllo chat` preloads input history for the selected `--cwd`, with the current
or resumed session's prompts first.

`mllo observe` starts a read-only local observer API bound to `127.0.0.1` by
default. It reads `state.sqlite`, `session_index.jsonl`, transcript JSONL files,
and `dump-prompts` files, then exposes sessions, timeline entries, prompt dumps,
tool events, and raw redacted JSON through JSON endpoints. It does not execute
tools or participate in agent decisions.

## Quick Start

```ts
import { runAgentCoreController } from '@mllo/agent-core'

for await (const event of runAgentCoreController({
  cwd: process.cwd(),
  input: 'Inspect this project and summarize its structure.',
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

The controller is an async generator. A host can render events as CLI output,
GUI timeline items, logs, WebSocket messages, or test assertions.

Hosts can inject domain capabilities through `additionalTools`. Set
`includeBaseTools: false` to expose only host-owned tools for products that do
not need the general coding toolset.

## Configuration

You can pass a provider directly:

```ts
modelProvider: {
  protocol: 'anthropic',
  baseUrl: 'https://example.com',
  apiKey: process.env.MODEL_API_KEY!,
  model: 'agent-model',
  maxTokens: 4096,
  contextWindowTokens: 200000,
  temperature: 0.1
}
```

Anthropic-compatible gateways that expect a bearer token can set
`anthropicAuthHeader: 'authorization'`; the default is the standard `x-api-key` header.

Or load providers from an mllo config file:

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
      "contextWindowTokens": 65536,
      "promptProfile": "local-compact"
    }
  ]
}
```

Use `promptProfile: "local-compact"` for small local context windows. Use the
default full profile when the provider can handle larger system context. Set
`contextWindowTokens` when the provider exposes a known context window.

## Claude and Codex Workers

The root package stays model/runtime focused. Worker adapters are exported from
subpaths so host apps only load what they use:

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
  input: 'Ask Claude to review and Codex to propose a patch.',
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

Prerequisites:

- `@mllo/agent-core/claude-sdk` requires `@anthropic-ai/claude-agent-sdk`.
  It is an optional peer dependency so importing the root core does not force
  Claude SDK onto every host.
- `@mllo/agent-core/codex-cli` requires a working `codex` command on `PATH`, or
  pass `command` / `spawnImpl` when creating the worker.
- Both workers route dangerous actions back through the mllo worker permission
  bridge before running shell or file mutation work.

## Runtime Home

Host apps should pass explicit runtime paths instead of letting the core guess
where state belongs:

```ts
session: {
  configDir: `${home}/.mllo`,
  stateDbPath: `${home}/.mllo/state.sqlite`
}
```

Typical runtime files:

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
external-traces/
```

## Observability

Prompt dumping is disabled by default because it can include private paths,
tool schemas, messages, and model responses.

Enable it only for local debugging:

```sh
MLLO_DUMP_PROMPTS=1
```

Dumped requests and responses are written to:

```text
~/.mllo/dump-prompts/<session-id>.jsonl
```

Use this when diagnosing provider protocol issues, tool schema bloat, context
growth, streaming errors, or unexpected model behavior.

`mllo observe` can also start a local Anthropic-compatible trace proxy for
debugging another agent or host process. Supported endpoints include Anthropic
`/v1/messages`, OpenAI-compatible `/v1/chat/completions`, and OpenAI Responses
`/v1/responses`:

```sh
mllo observe --anthropic-trace-proxy --trace-proxy-port 43111
export ANTHROPIC_BASE_URL=http://127.0.0.1:43111

mllo observe --openai-trace-proxy --openai-trace-proxy-port 43112
export OPENAI_BASE_URL=http://127.0.0.1:43112/v1
```

The proxy forwards requests to the real upstream and writes redacted summaries
to `~/.mllo/external-traces/<source>.jsonl`. Add `--trace-capture-bodies` only
when you intentionally want redacted request/response bodies stored for local debugging.

## Architecture

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

The core does not decide how approval dialogs look, where secrets are stored,
which model vendor is preferred, or what product surface wraps the runtime.

## What This Package Is Not

- Not a terminal UI.
- Not an Electron app.
- Not a hosted agent service.
- Not tied to one model vendor.
- Not tied to one external coding agent.
- Not a replacement for your product's permission UX.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Embedding guide](./docs/EMBEDDING.md)

## License

MIT. See [LICENSE](./LICENSE).
