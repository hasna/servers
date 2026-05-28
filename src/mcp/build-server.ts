import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { registerServerTools } from "./tools/servers.js";
import { registerOperationTools } from "./tools/operations.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerTraceTools } from "./tools/traces.js";
import { registerWebhookTools } from "./tools/webhooks.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerLockTools } from "./tools/locks.js";

let serverInstance: McpServer | null = null;

function getMcpVersion(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dir, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

type Helpers = {
  shouldRegisterTool: (name: string) => boolean;
  resolveId: (id: string, table?: string) => string;
  formatError: (e: unknown) => string;
};

const toolContext: Helpers = {
  shouldRegisterTool: () => true,
  resolveId: (id: string) => id,
  formatError: (e: unknown) => {
    if (e instanceof Error) return e.message;
    return String(e);
  },
};

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "servers",
    version: getMcpVersion(),
  });

  registerServerTools(server, toolContext);
  registerOperationTools(server, toolContext);
  registerAgentTools(server, toolContext);
  registerTraceTools(server, toolContext);
  registerWebhookTools(server, toolContext);
  registerProjectTools(server, toolContext);
  registerLockTools(server, toolContext);

  return server;
}

export function buildServer(): McpServer {
  if (!serverInstance) serverInstance = createMcpServer();
  return serverInstance;
}

/** @internal test helper */
export function resetServerForTests(): void {
  serverInstance = null;
}
