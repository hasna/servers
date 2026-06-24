import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWebhook, getWebhook, listWebhooks, deleteWebhook, listDeliveries } from "../../db/webhooks.js";
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

export function registerWebhookTools(server: McpServer, { shouldRegisterTool, formatError }: Helpers): void {

  if (shouldRegisterTool("create_webhook")) {
    server.tool(
      "create_webhook",
      "Register a webhook endpoint. URL must be HTTPS and cannot target localhost or private IPs.",
      {
        url: z.string().describe("HTTPS webhook URL"),
        events: z.array(z.string()).optional().describe("Events to subscribe to (empty = all)"),
        secret: z.string().optional().describe("HMAC signing secret"),
        project_id: z.string().optional(),
        server_id: z.string().optional(),
        agent_id: z.string().optional(),
        operation_id: z.string().optional(),
      },
      async ({ url, events, secret, project_id, server_id, agent_id, operation_id }) => {
        try {
          const wh = createWebhook({ url, events, secret, project_id, server_id, agent_id, operation_id });
          return { content: [{ type: "text" as const, text: `Created webhook: ${wh.id.slice(0, 8)} -> ${wh.url}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("get_webhook")) {
    server.tool(
      "get_webhook",
      "Get a webhook by ID.",
      { id: z.string() },
      async ({ id }) => {
        try {
          const wh = getWebhook(id);
          if (!wh) return { content: [{ type: "text" as const, text: `Webhook not found: ${id}` }], isError: true };
          return { content: [{ type: "text" as const, text: JSON.stringify(wh, null, 2) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("list_webhooks")) {
    server.tool(
      "list_webhooks",
      "List all webhooks.",
      {
        limit: z.number().int().positive().optional().default(DEFAULT_MCP_LIST_LIMIT),
        cursor: z.number().int().nonnegative().optional().default(0),
        verbose: z.boolean().optional().default(false).describe("Include scope filters and creation time"),
      },
      async ({ limit, cursor, verbose }) => {
        try {
          const webhooks = listWebhooks();
          if (webhooks.length === 0) return { content: [{ type: "text" as const, text: "No webhooks found." }] };
          const page = pageItems(webhooks, normalizeListLimit(limit), normalizeCursor(cursor));
          const lines = page.rows.map(w => {
            const base = `${w.id.slice(0, 8)}  ${(w.active ? "active" : "inactive").padEnd(10)} ${truncateValue(w.url, 72)}  events:${truncateValue(w.events.join(",") || "*", 48)}`;
            if (!verbose) return base;
            return `${base} server:${truncateValue(w.server_id, 12)} project:${truncateValue(w.project_id, 12)} agent:${truncateValue(w.agent_id, 12)} operation:${truncateValue(w.operation_id, 12)} created:${w.created_at}`;
          });
          return { content: [{ type: "text" as const, text: appendListFooter(lines.join("\n"), { shown: page.rows.length, total: page.total, nextCursor: page.nextCursor, detailHint: "get_webhook", verboseHint: !verbose }) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("delete_webhook")) {
    server.tool(
      "delete_webhook",
      "Delete a webhook.",
      { id: z.string() },
      async ({ id }) => {
        try {
          deleteWebhook(id);
          return { content: [{ type: "text" as const, text: `Deleted webhook ${id.slice(0, 8)}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("list_deliveries")) {
    server.tool(
      "list_deliveries",
      "List webhook delivery logs.",
      {
        webhook_id: z.string().optional(),
        limit: z.number().int().positive().optional().default(DEFAULT_MCP_LIST_LIMIT),
        cursor: z.number().int().nonnegative().optional().default(0),
        verbose: z.boolean().optional().default(false).describe("Include response summary"),
      },
      async ({ webhook_id, limit, cursor, verbose }) => {
        try {
          const normalizedLimit = normalizeListLimit(limit);
          const normalizedCursor = normalizeCursor(cursor);
          const fetched = listDeliveries(webhook_id, normalizedCursor + normalizedLimit + 1);
          const deliveries = fetched.slice(normalizedCursor, normalizedCursor + normalizedLimit);
          if (deliveries.length === 0) {
            const text = normalizedCursor > 0 && fetched.length > 0
              ? `No deliveries at cursor ${normalizedCursor}; ${fetched.length} matching delivery record(s) exist before this page. Use cursor=0 or a smaller cursor.`
              : "No deliveries found.";
            return { content: [{ type: "text" as const, text }] };
          }
          const lines = deliveries.map(d => {
            const base = `${d.id.slice(0, 8)}  ${truncateValue(d.event, 36).padEnd(36)} status:${d.status_code ?? "-"} attempt:${d.attempt} ${d.created_at}`;
            if (!verbose) return base;
            return `${base} response:${truncateValue(d.response, 64)}`;
          });
          return { content: [{ type: "text" as const, text: appendListFooter(lines.join("\n"), { shown: deliveries.length, nextCursor: fetched.length > normalizedCursor + normalizedLimit ? normalizedCursor + normalizedLimit : null, verboseHint: !verbose }) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }
}
