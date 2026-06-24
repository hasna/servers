import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { closeDatabase, getDatabase } from "../db/database.js";
import { buildServer, createMcpServer, resetServerForTests } from "./build-server.js";
import { getListeningPort, startMcpHttpServer } from "./http.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createHttpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const first = content?.[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

function resultJson(result: Awaited<ReturnType<Client["callTool"]>>): any {
  return JSON.parse(resultText(result));
}

describe("buildServer", () => {
  beforeEach(() => {
    process.env.SERVERS_DB_PATH = ":memory:";
  });

  afterEach(() => {
    resetServerForTests();
    closeDatabase();
    delete process.env.SERVERS_DB_PATH;
  });

  it("constructs a server and registers tools", async () => {
    getDatabase();
    const server = buildServer();
    expect(server).toBeDefined();
    expect(buildServer()).toBe(server);

    let httpServer: Server | undefined;
    try {
      httpServer = await startMcpHttpServer({
        port: 0,
        healthName: "servers",
        createServer: createMcpServer,
      });
      const port = getListeningPort(httpServer);
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === "list_servers")).toBe(true);
      expect(tools.some((t) => t.name === "start_local_server")).toBe(true);
      await client.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer?.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("startMcpHttpServer", () => {
  let httpServer: Server | undefined;

  beforeEach(() => {
    process.env.SERVERS_DB_PATH = ":memory:";
    getDatabase();
  });

  afterEach(async () => {
    resetServerForTests();
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
      httpServer = undefined;
    }
    closeDatabase();
    delete process.env.SERVERS_DB_PATH;
  });

  it("serves GET /health", async () => {
    httpServer = await startMcpHttpServer({
      port: 0,
      healthName: "servers",
      createServer: createMcpServer,
    });
    const port = getListeningPort(httpServer);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "servers" });
  });

  it("handles MCP initialize and tool call over Streamable HTTP", async () => {
    httpServer = await startMcpHttpServer({
      port: 0,
      healthName: "servers",
      createServer: createMcpServer,
    });
    const port = getListeningPort(httpServer);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.callTool({ name: "list_servers", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content).toBeDefined();

    await client.close();
  });

  it("keeps MCP list tools compact and paginated by default", async () => {
    httpServer = await startMcpHttpServer({
      port: 0,
      healthName: "servers",
      createServer: createMcpServer,
    });
    const port = getListeningPort(httpServer);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);

    try {
      for (let i = 0; i < 25; i++) {
        const suffix = String(i).padStart(2, "0");
        const created = await client.callTool({
          name: "create_server",
          arguments: { name: `MCP Server ${suffix}`, slug: `mcp-server-${suffix}` },
        });
        expect(created.isError).not.toBe(true);
      }

      const firstPage = await client.callTool({ name: "list_servers", arguments: {} });
      const firstPageText = resultText(firstPage);
      expect(firstPage.isError).not.toBe(true);
      expect(firstPageText).toContain("Showing 20 of 25");
      expect(firstPageText).toContain("cursor=20");
      expect(firstPageText).toContain("get_server");

      const secondPage = await client.callTool({ name: "list_servers", arguments: { cursor: 20 } });
      expect(secondPage.isError).not.toBe(true);
      expect(resultText(secondPage)).toContain("Showing 5 of 25");
    } finally {
      await client.close();
    }
  });

  it("serves multiple concurrent clients from one process", async () => {
    httpServer = await startMcpHttpServer({
      port: 0,
      healthName: "servers",
      createServer: createMcpServer,
    });
    const port = getListeningPort(httpServer);

    const clients = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
        const client = new Client({ name: "test", version: "1.0.0" });
        await client.connect(transport);
        return client;
      }),
    );

    const results = await Promise.all(
      clients.map((client) => client.callTool({ name: "list_servers", arguments: {} })),
    );
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.isError).not.toBe(true);
    }

    await Promise.all(clients.map((client) => client.close()));
  });

  it("starts, checks, and stops a local server through MCP tools", async () => {
    const appDir = makeTempDir("servers-mcp-app-");
    const port = await getFreePort();
    let pid: number | undefined;

    writeFileSync(
      join(appDir, "server.js"),
      `
const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    );

    httpServer = await startMcpHttpServer({
      port: 0,
      healthName: "servers",
      createServer: createMcpServer,
    });
    const mcpPort = getListeningPort(httpServer);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`));
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);

    try {
      const init = await client.callTool({
        name: "init_local_server",
        arguments: {
          name: "mcp-app",
          path: appDir,
          command: "bun run server.js",
          port,
          env: { PORT: String(port) },
        },
      });
      expect(init.isError).not.toBe(true);
      expect(resultJson(init).server.slug).toBe("mcp-app");

      const duplicateInit = await client.callTool({
        name: "init_local_server",
        arguments: {
          name: "mcp-app",
          path: appDir,
          command: "bun run other-server.js",
          port,
        },
      });
      expect(duplicateInit.isError).toBe(true);
      expect(resultText(duplicateInit)).toContain("Pass force: true");

      const start = await client.callTool({
        name: "start_local_server",
        arguments: {
          id_or_slug: "mcp-app",
          agent_id: "mcp-test-agent",
          reason: "mcp regression",
          timeout_ms: 8000,
        },
      });
      expect(start.isError).not.toBe(true);
      const started = resultJson(start);
      pid = started.pid;
      expect(started.ready).toBe(true);
      expect(started.server.status).toBe("online");

      const status = await client.callTool({
        name: "get_local_server_status",
        arguments: { id_or_slug: "mcp-app", refresh: true },
      });
      expect(status.isError).not.toBe(true);
      expect(resultJson(status).snapshot.ready).toBe(true);

      const stop = await client.callTool({
        name: "stop_local_server",
        arguments: {
          id_or_slug: "mcp-app",
          agent_id: "mcp-test-agent",
          stop_timeout_ms: 8000,
        },
      });
      expect(stop.isError).not.toBe(true);
      pid = undefined;
      expect(resultJson(stop).server.status).toBe("offline");
    } finally {
      await client.close();
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    }
  });
});
