import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";

import { closeDatabase, getDatabase } from "../db/database.js";
import { buildServer, createMcpServer, resetServerForTests } from "./build-server.js";
import { getListeningPort, startMcpHttpServer } from "./http.js";

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
});
