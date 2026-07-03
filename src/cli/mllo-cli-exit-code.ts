import type { AgentCoreRunControllerResult } from "../agent-core/runtime/agent-core-run-controller-types";

export function exitCodeFromMlloRunResult(result: AgentCoreRunControllerResult): number {
  switch (result.status) {
    case "completed":
      return 0;
    case "stopped":
      return 130;
    case "waiting-for-permission":
    case "waiting-for-elicitation":
    case "denied":
    case "error":
      return 1;
  }
}
