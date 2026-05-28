#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { parseMcpArgs, isHttpMode, resolveHttpPort } from "./args.js";
import { buildServer, createMcpServer } from "./build-server.js";
import { startMcpHttpServer, DEFAULT_MCP_HTTP_PORT, MCP_HTTP_HOST } from "./http.js";

export { buildServer } from "./build-server.js";
export { startMcpHttpServer, DEFAULT_MCP_HTTP_PORT, MCP_HTTP_HOST } from "./http.js";

function getMcpVersion(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dir, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const parsedArgs = parseMcpArgs(process.argv.slice(2), getMcpVersion());
if (parsedArgs) {
  console.log(parsedArgs.text);
  process.exit(0);
}

async function main(): Promise<void> {
  if (isHttpMode()) {
    const port = resolveHttpPort(DEFAULT_MCP_HTTP_PORT);
    await startMcpHttpServer({
      port,
      healthName: "servers",
      createServer: createMcpServer,
    });
    console.error(`servers-mcp HTTP listening on http://${MCP_HTTP_HOST}:${port}/mcp`);
    return;
  }

  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
