export function renderMlloCliHelp(): string {
  return `mllo Agent Core CLI

Usage:
  mllo [prompt...]
  mllo run [prompt...]
  mllo chat
  mllo observe
  mllo config path
  mllo config init [--force]

Commands:
  run              Run one non-interactive agent turn.
  chat             Start a line-based interactive session.
  observe          Start the read-only local observer API.
  config path      Print the active config path.
  config init      Create a local starter config.

Options:
  -p, --print                         Run once instead of opening chat.
      --output-format <format>        text | json | stream-json.
      --json                          Shortcut for --output-format json.
      --input-format <format>         text. stream-json is reserved for later.
      --cwd <path>                    Project working directory.
      --home <path>                   Runtime home. Defaults to ~/.mllo.
      --config <path>                 Config file. Defaults to <home>/config.json.
      --provider <name>               Provider name from config.json.
      --permission-mode <mode>        ask | auto-readonly | workspace-write | dangerously-bypass.
      --dangerously-skip-permissions  Shortcut for --permission-mode dangerously-bypass.
      --max-turns <n>                 Limit model/tool loop turns.
      --session-id <id>               Continue a known session id without loading transcript.
      --resume <id>                   Resume a known session id from transcript.
      --host <host>                   Observer host. Defaults to 127.0.0.1.
      --port <port>                   Observer port. Defaults to 43110.
      --anthropic-trace-proxy         Start a local Anthropic /v1/messages trace proxy.
      --anthropic-trace-source <src>  External trace source. Defaults to mllo; use claude-code for Claude Code.
      --trace-proxy-host <host>       Trace proxy host. Defaults to 127.0.0.1.
      --trace-proxy-port <port>       Trace proxy port. Defaults to 43111.
      --anthropic-upstream <url>      Real Anthropic-compatible upstream. Defaults to https://api.anthropic.com.
      --openai-trace-proxy            Start a local OpenAI-compatible trace proxy.
      --openai-trace-source <src>     External trace source. Defaults to mllo; use codex-cli for Codex CLI.
      --openai-trace-proxy-host <h>   OpenAI trace proxy host. Defaults to 127.0.0.1.
      --openai-trace-proxy-port <p>   OpenAI trace proxy port. Defaults to 43112.
      --openai-upstream <url>         Real OpenAI-compatible upstream. Defaults to https://api.openai.com.
      --trace-capture-bodies          Store redacted request/response bodies in external trace JSONL.
      --langfuse-export-external-traces
                                      Export external trace JSONL records to Langfuse generations.
      --langfuse-export-interval-ms <n>
                                      External trace Langfuse export interval. Defaults to 2000.
  -c, --continue                      Resume the latest session for --cwd.
  -h, --help                          Show help.
  -v, --version                       Show version.

Examples:
  mllo config init
  mllo run "summarize this project" --permission-mode auto-readonly
  mllo observe --port 43110
  mllo observe --anthropic-trace-proxy --trace-proxy-port 43111
  mllo observe --anthropic-trace-proxy --anthropic-trace-source claude-code --trace-capture-bodies --langfuse-export-external-traces
  mllo observe --openai-trace-proxy --openai-trace-proxy-port 43112
  mllo -p --output-format stream-json "inspect package.json"
`;
}

export function renderMlloCliVersion(version: string): string {
  return `mllo ${version}`;
}
