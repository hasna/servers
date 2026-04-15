import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createServer,
  getServer,
  getServerBySlug,
  listServers,
  updateServer,
  deleteServer,
  lockServer,
  unlockServer,
  heartbeatServer,
} from "../../db/servers.js";
import { dispatchWebhook } from "../../db/webhooks.js";

type Helpers = {
  shouldRegisterTool: (name: string) => boolean;
  resolveId: (id: string, table?: string) => string;
  formatError: (e: unknown) => string;
};

export function registerServerTools(server: McpServer, { shouldRegisterTool, formatError }: Helpers): void {

  if (shouldRegisterTool("create_server")) {
    server.tool(
      "create_server",
      "Register a new server for management.",
      {
        name: z.string().describe("Server name (unique)"),
        slug: z.string().optional().describe("URL-friendly slug (auto-generated from name if omitted)"),
        hostname: z.string().optional().describe("Hostname or IP address"),
        path: z.string().optional().describe("SSH path or local path"),
        description: z.string().optional(),
        status: z.enum(["online", "offline", "starting", "stopping", "restarting", "deploying", "maintenance", "unknown"]).optional(),
        metadata: z.record(z.unknown()).optional(),
        project_id: z.string().optional(),
      },
      async ({ name, slug, hostname, path, description, status, metadata, project_id }) => {
        try {
          const s = createServer({ name, slug, hostname, path, description, status, metadata, project_id });
          return { content: [{ type: "text" as const, text: `Created server: ${s.name} (${s.slug}, id: ${s.id.slice(0, 8)})` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("get_server")) {
    server.tool(
      "get_server",
      "Get a server by ID or slug.",
      { id_or_slug: z.string().describe("Server UUID (or prefix) or slug") },
      async ({ id_or_slug }) => {
        try {
          let s = getServer(id_or_slug);
          if (!s) s = getServerBySlug(id_or_slug);
          if (!s) return { content: [{ type: "text" as const, text: `Server not found: ${id_or_slug}` }], isError: true };
          return { content: [{ type: "text" as const, text: JSON.stringify(s, null, 2) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("list_servers")) {
    server.tool(
      "list_servers",
      "List all registered servers.",
      { project_id: z.string().optional().describe("Filter by project") },
      async ({ project_id }) => {
        try {
          const servers = listServers(project_id);
          if (servers.length === 0) return { content: [{ type: "text" as const, text: "No servers found." }] };
          const lines = servers.map(s => `${s.id.slice(0, 8)}  ${s.status.padEnd(12)} ${s.name.padEnd(20)} ${s.slug}  ${s.hostname || "-"}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("update_server")) {
    server.tool(
      "update_server",
      "Update server properties.",
      {
        id: z.string().describe("Server ID"),
        name: z.string().optional(),
        slug: z.string().optional(),
        hostname: z.string().nullable().optional(),
        path: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        status: z.enum(["online", "offline", "starting", "stopping", "restarting", "deploying", "maintenance", "unknown"]).optional(),
        metadata: z.record(z.unknown()).optional(),
        project_id: z.string().nullable().optional(),
      },
      async ({ id, ...rest }) => {
        try {
          const s = updateServer(id, rest as any);
          return { content: [{ type: "text" as const, text: `Updated: ${s.name} (${s.status})` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("delete_server")) {
    server.tool(
      "delete_server",
      "Delete a server. Fails if the server is currently locked.",
      { id: z.string().describe("Server ID") },
      async ({ id }) => {
        try {
          deleteServer(id);
          return { content: [{ type: "text" as const, text: `Deleted server ${id.slice(0, 8)}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("lock_server")) {
    server.tool(
      "lock_server",
      "Acquire an exclusive lock on a server. Other agents cannot operate on a locked server.",
      { server_id: z.string(), agent_id: z.string().describe("Agent requesting the lock") },
      async ({ server_id, agent_id }) => {
        try {
          const s = lockServer(server_id, agent_id);
          return { content: [{ type: "text" as const, text: `Locked ${s.name} for ${agent_id}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("unlock_server")) {
    server.tool(
      "unlock_server",
      "Release a lock on a server. Only the locking agent can unlock.",
      { server_id: z.string(), agent_id: z.string() },
      async ({ server_id, agent_id }) => {
        try {
          const s = unlockServer(server_id, agent_id);
          return { content: [{ type: "text" as const, text: `Unlocked ${s.name}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("server_heartbeat")) {
    server.tool(
      "server_heartbeat",
      "Record a heartbeat for a server.",
      { server_id: z.string() },
      async ({ server_id }) => {
        try {
          const s = heartbeatServer(server_id);
          return { content: [{ type: "text" as const, text: `Heartbeat recorded for ${s.name} at ${s.last_heartbeat}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }
}
