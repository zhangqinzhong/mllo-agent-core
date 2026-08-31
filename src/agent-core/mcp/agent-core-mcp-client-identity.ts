import { MLLO_AGENT_CORE_VERSION } from "../agent-core-version";

export interface AgentCoreMcpClientIdentity {
  name: "mllo-agent-core";
  version: string;
}

/**
 * Builds the identity sent during an MCP initialize handshake.
 *
 * package.json is the release version source of truth. Keeping the read as a
 * static JSON import lets TypeScript and browser bundlers include the metadata
 * without relying on Node-only filesystem APIs at runtime.
 */
export function createAgentCoreMcpClientIdentity(): AgentCoreMcpClientIdentity {
  return {
    name: "mllo-agent-core",
    version: MLLO_AGENT_CORE_VERSION,
  };
}
