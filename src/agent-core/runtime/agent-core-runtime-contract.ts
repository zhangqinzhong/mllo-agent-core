import { MLLO_STATE_SCHEMA_VERSION } from "../runtime-state/mllo-state-schema";
import { AGENT_CORE_INTERACTION_SCHEMA_VERSION } from "../interactions/agent-core-interaction-types";

// 宿主用这些整数判断协议语义，而不是从 npm 包版本或事件字段猜测兼容性。
export const AGENT_CORE_RUNTIME_CONTRACT_VERSION = 1;
export const AGENT_CORE_QUERY_EVENT_SCHEMA_VERSION = 1;

export type AgentCoreRuntimeCapabilities = Readonly<{
  runtimeContractVersion: number;
  queryEventSchemaVersion: number;
  interactionSchemaVersion: number;
  stateSchemaVersion: number;
}>;

const AGENT_CORE_RUNTIME_CAPABILITIES: AgentCoreRuntimeCapabilities = Object.freeze({
  runtimeContractVersion: AGENT_CORE_RUNTIME_CONTRACT_VERSION,
  queryEventSchemaVersion: AGENT_CORE_QUERY_EVENT_SCHEMA_VERSION,
  interactionSchemaVersion: AGENT_CORE_INTERACTION_SCHEMA_VERSION,
  stateSchemaVersion: MLLO_STATE_SCHEMA_VERSION,
});

// 无 I/O 的能力握手。宿主可以在打开 session/state.sqlite 前完成版本门禁。
export function getAgentCoreRuntimeCapabilities(): AgentCoreRuntimeCapabilities {
  return AGENT_CORE_RUNTIME_CAPABILITIES;
}
