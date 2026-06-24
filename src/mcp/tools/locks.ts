import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { acquireLock, releaseLock, checkLock, cleanExpiredLocks, getLocksByAgent } from "../../db/locks.js";
import {
  appendListFooter,
  DEFAULT_MCP_LIST_LIMIT,
  normalizeCursor,
  normalizeListLimit,
  pageItems,
  truncateValue,
} from "./output.js";

type Helpers = {
  shouldRegisterTool: (name: string) => boolean;
  resolveId: (id: string, table?: string) => string;
  formatError: (e: unknown) => string;
};

export function registerLockTools(server: McpServer, { shouldRegisterTool, formatError }: Helpers): void {

  if (shouldRegisterTool("acquire_lock")) {
    server.tool(
      "acquire_lock",
      "Acquire a resource lock. Returns false if already locked by another agent.",
      {
        resource_type: z.string().describe("Type of resource (e.g. 'server', 'config')"),
        resource_id: z.string(),
        agent_id: z.string(),
        lock_type: z.enum(["advisory", "exclusive"]).optional().default("advisory"),
        expiry_minutes: z.number().int().positive().optional().default(5).describe("Lock duration in minutes"),
      },
      async ({ resource_type, resource_id, agent_id, lock_type, expiry_minutes }) => {
        try {
          const success = acquireLock(resource_type, resource_id, agent_id, lock_type, expiry_minutes * 60 * 1000);
          return { content: [{ type: "text" as const, text: success ? `Lock acquired: ${resource_type}/${resource_id} by ${agent_id}` : `Lock denied: ${resource_type}/${resource_id} is locked by another agent` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("release_lock")) {
    server.tool(
      "release_lock",
      "Release a resource lock.",
      {
        resource_type: z.string(),
        resource_id: z.string(),
        agent_id: z.string(),
      },
      async ({ resource_type, resource_id, agent_id }) => {
        try {
          const success = releaseLock(resource_type, resource_id, agent_id);
          return { content: [{ type: "text" as const, text: success ? `Lock released: ${resource_type}/${resource_id}` : `Lock not found or not owned by ${agent_id}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("check_lock")) {
    server.tool(
      "check_lock",
      "Check if a resource is currently locked.",
      { resource_type: z.string(), resource_id: z.string() },
      async ({ resource_type, resource_id }) => {
        try {
          const lock = checkLock(resource_type, resource_id);
          if (!lock) return { content: [{ type: "text" as const, text: `Not locked: ${resource_type}/${resource_id}` }] };
          return { content: [{ type: "text" as const, text: `Locked by ${lock.agent_id} (expires: ${lock.expires_at})` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("locks_by_agent")) {
    server.tool(
      "locks_by_agent",
      "List all active locks held by an agent.",
      {
        agent_id: z.string(),
        limit: z.number().int().positive().optional().default(DEFAULT_MCP_LIST_LIMIT),
        cursor: z.number().int().nonnegative().optional().default(0),
      },
      async ({ agent_id, limit, cursor }) => {
        try {
          const locks = getLocksByAgent(agent_id);
          if (locks.length === 0) return { content: [{ type: "text" as const, text: `No locks held by ${agent_id}` }] };
          const page = pageItems(locks, normalizeListLimit(limit), normalizeCursor(cursor));
          const lines = page.rows.map(l => `${truncateValue(l.resource_type, 24)}/${truncateValue(l.resource_id, 24)}  ${l.lock_type.padEnd(12)} expires:${l.expires_at}`);
          return { content: [{ type: "text" as const, text: appendListFooter(lines.join("\n"), { shown: page.rows.length, total: page.total, nextCursor: page.nextCursor }) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("clean_expired_locks")) {
    server.tool(
      "clean_expired_locks",
      "Remove expired locks. Returns count of cleaned entries.",
      {},
      async () => {
        try {
          const count = cleanExpiredLocks();
          return { content: [{ type: "text" as const, text: `Cleaned ${count} expired locks` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }
}
