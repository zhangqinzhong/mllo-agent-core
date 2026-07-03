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
  observe          Start the read-only local web observer.
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
  -c, --continue                      Resume the latest session for --cwd.
  -h, --help                          Show help.
  -v, --version                       Show version.

Examples:
  mllo config init
  mllo run "summarize this project" --permission-mode auto-readonly
  mllo observe --port 43110
  mllo -p --output-format stream-json "inspect package.json"
`;
}

export function renderMlloCliVersion(version: string): string {
  return `mllo ${version}`;
}
