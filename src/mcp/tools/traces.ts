import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createTrace, getTrace, listTraces, listTracesByAgent } from "../../db/traces.js";
import {
  appendListFooter,
  DEFAULT_MCP_LIST_LIMIT,
  normalizeCursor,
  normalizeListLimit,
  truncateValue,
} from "./output.js";

type Helpers = {
  shouldRegisterTool: (name: string) => boolean;
  resolveId: (id: string, table?: string) => string;
  formatError: (e: unknown) => string;
};

export function registerTraceTools(server: McpServer, { shouldRegisterTool, formatError }: Helpers): void {

  if (shouldRegisterTool("create_trace")) {
    server.tool(
      "create_trace",
      "Record an audit trail event for a server operation.",
      {
        server_id: z.string(),
        event: z.string().describe("Event name (e.g. 'server.started', 'deploy.failed')"),
        operation_id: z.string().nullable().optional(),
        agent_id: z.string().nullable().optional(),
        details: z.record(z.unknown()).optional(),
      },
      async ({ server_id, event, operation_id, agent_id, details }) => {
        try {
          const trace = createTrace({ server_id, event, operation_id, agent_id, details });
          return { content: [{ type: "text" as const, text: `Trace: ${event} for ${server_id.slice(0, 8)} (${trace.id.slice(0, 8)})` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("get_trace")) {
    server.tool(
      "get_trace",
      "Get a trace by ID.",
      { id: z.string() },
      async ({ id }) => {
        try {
          const trace = getTrace(id);
          if (!trace) return { content: [{ type: "text" as const, text: `Trace not found: ${id}` }], isError: true };
          return { content: [{ type: "text" as const, text: JSON.stringify(trace, null, 2) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("list_traces")) {
    server.tool(
      "list_traces",
      "List audit trail entries.",
      {
        server_id: z.string().optional(),
        operation_id: z.string().nullable().optional(),
        limit: z.number().int().positive().optional().default(DEFAULT_MCP_LIST_LIMIT),
        cursor: z.number().int().nonnegative().optional().default(0),
        verbose: z.boolean().optional().default(false).describe("Include operation IDs and details summary"),
      },
      async ({ server_id, operation_id, limit, cursor, verbose }) => {
        try {
          const normalizedLimit = normalizeListLimit(limit);
          const normalizedCursor = normalizeCursor(cursor);
          const fetched = listTraces(server_id, operation_id, normalizedCursor + normalizedLimit + 1);
          const traces = fetched.slice(normalizedCursor, normalizedCursor + normalizedLimit);
          if (traces.length === 0) {
            const text = normalizedCursor > 0 && fetched.length > 0
              ? `No traces at cursor ${normalizedCursor}; ${fetched.length} matching trace(s) exist before this page. Use cursor=0 or a smaller cursor.`
              : "No traces found.";
            return { content: [{ type: "text" as const, text }] };
          }
          const lines = traces.map(t => {
            const base = `${t.id.slice(0, 8)}  ${truncateValue(t.event, 36).padEnd(36)} server:${t.server_id.slice(0, 8)} agent:${truncateValue(t.agent_id, 20)}  ${t.created_at}`;
            if (!verbose) return base;
            return `${base} op:${truncateValue(t.operation_id, 12)} details:${truncateValue(JSON.stringify(t.details), 64)}`;
          });
          return { content: [{ type: "text" as const, text: appendListFooter(lines.join("\n"), { shown: traces.length, nextCursor: fetched.length > normalizedCursor + normalizedLimit ? normalizedCursor + normalizedLimit : null, detailHint: "get_trace", verboseHint: !verbose }) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("list_traces_by_agent")) {
    server.tool(
      "list_traces_by_agent",
      "List audit trail entries by agent.",
      {
        agent_id: z.string(),
        limit: z.number().int().positive().optional().default(DEFAULT_MCP_LIST_LIMIT),
        cursor: z.number().int().nonnegative().optional().default(0),
        verbose: z.boolean().optional().default(false).describe("Include operation IDs and details summary"),
      },
      async ({ agent_id, limit, cursor, verbose }) => {
        try {
          const normalizedLimit = normalizeListLimit(limit);
          const normalizedCursor = normalizeCursor(cursor);
          const fetched = listTracesByAgent(agent_id, normalizedCursor + normalizedLimit + 1);
          const traces = fetched.slice(normalizedCursor, normalizedCursor + normalizedLimit);
          if (traces.length === 0) {
            const text = normalizedCursor > 0 && fetched.length > 0
              ? `No traces at cursor ${normalizedCursor}; ${fetched.length} matching trace(s) exist before this page. Use cursor=0 or a smaller cursor.`
              : "No traces found for this agent.";
            return { content: [{ type: "text" as const, text }] };
          }
          const lines = traces.map(t => {
            const base = `${t.id.slice(0, 8)}  ${truncateValue(t.event, 36).padEnd(36)} server:${t.server_id.slice(0, 8)}  ${t.created_at}`;
            if (!verbose) return base;
            return `${base} op:${truncateValue(t.operation_id, 12)} details:${truncateValue(JSON.stringify(t.details), 64)}`;
          });
          return { content: [{ type: "text" as const, text: appendListFooter(lines.join("\n"), { shown: traces.length, nextCursor: fetched.length > normalizedCursor + normalizedLimit ? normalizedCursor + normalizedLimit : null, detailHint: "get_trace", verboseHint: !verbose }) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }
}
