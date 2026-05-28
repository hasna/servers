import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const MCP_HTTP_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 8834;

export interface StartMcpHttpOptions {
  port: number;
  host?: string;
  healthName: string;
  createServer: () => McpServer;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

export function getListeningPort(server: Server): number {
  const address = server.address();
  if (address && typeof address === "object") return address.port;
  throw new Error("HTTP server is not listening");
}

export function startMcpHttpServer(options: StartMcpHttpOptions): Promise<Server> {
  const host = options.host ?? MCP_HTTP_HOST;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${host}:${options.port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name: options.healthName }));
      return;
    }

    if (url.pathname === "/mcp" && (req.method === "POST" || req.method === "GET")) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
      });
      const mcpServer = options.createServer();
      await mcpServer.connect(transport);
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, host, () => resolve(httpServer));
  });
}
