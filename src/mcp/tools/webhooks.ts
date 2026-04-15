import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWebhook, getWebhook, listWebhooks, deleteWebhook, listDeliveries } from "../../db/webhooks.js";

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
      {},
      async () => {
        try {
          const webhooks = listWebhooks();
          if (webhooks.length === 0) return { content: [{ type: "text" as const, text: "No webhooks found." }] };
          const lines = webhooks.map(w => `${w.id.slice(0, 8)}  ${w.active ? "active" : "inactive".padEnd(10)} ${w.url}  events: ${w.events.join(",") || "*"}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
      { webhook_id: z.string().optional(), limit: z.number().optional().default(50) },
      async ({ webhook_id, limit }) => {
        try {
          const deliveries = listDeliveries(webhook_id, limit);
          if (deliveries.length === 0) return { content: [{ type: "text" as const, text: "No deliveries found." }] };
          const lines = deliveries.map(d => `${d.id.slice(0, 8)}  ${d.event.padEnd(30)} ${d.status_code ?? "-"}  attempt ${d.attempt}  ${d.created_at}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }
}
