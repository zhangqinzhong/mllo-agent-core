import { describe, expect, it } from "vitest";
import packageMetadata from "../../package.json";
import { MLLO_AGENT_CORE_VERSION } from "../../src/agent-core/agent-core-version";
import { createAgentCoreMcpClientIdentity } from "../../src/agent-core/mcp/agent-core-mcp-client-identity";

describe("MCP client identity", () => {
  it("uses the package release version for MCP handshakes", () => {
    expect(MLLO_AGENT_CORE_VERSION).toBe(packageMetadata.version);
    expect(createAgentCoreMcpClientIdentity()).toEqual({
      name: "mllo-agent-core",
      version: packageMetadata.version,
    });
  });

  it("returns an isolated identity object for each SDK client", () => {
    const first = createAgentCoreMcpClientIdentity();
    const second = createAgentCoreMcpClientIdentity();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
