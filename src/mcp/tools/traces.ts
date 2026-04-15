import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createTrace, getTrace, listTraces, listTracesByAgent } from "../../db/traces.js";

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
        limit: z.number().optional().default(100),
      },
      async ({ server_id, operation_id, limit }) => {
        try {
          const traces = listTraces(server_id, operation_id, limit);
          if (traces.length === 0) return { content: [{ type: "text" as const, text: "No traces found." }] };
          const lines = traces.map(t => `${t.id.slice(0, 8)}  ${t.event.padEnd(30)} server:${t.server_id.slice(0, 8)}  ${t.agent_id || "-"}  ${t.created_at}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("list_traces_by_agent")) {
    server.tool(
      "list_traces_by_agent",
      "List audit trail entries by agent.",
      { agent_id: z.string(), limit: z.number().optional().default(50) },
      async ({ agent_id, limit }) => {
        try {
          const traces = listTracesByAgent(agent_id, limit);
          if (traces.length === 0) return { content: [{ type: "text" as const, text: "No traces found for this agent." }] };
          const lines = traces.map(t => `${t.id.slice(0, 8)}  ${t.event.padEnd(30)} server:${t.server_id.slice(0, 8)}  ${t.created_at}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }
}
