import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createOperation,
  getOperation,
  listOperations,
  updateOperation,
  startOperation,
  completeOperation,
  failOperation,
  cancelOperation,
  deleteOperation,
} from "../../db/operations.js";
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

export function registerOperationTools(server: McpServer, { shouldRegisterTool, formatError }: Helpers): void {

  if (shouldRegisterTool("create_operation")) {
    server.tool(
      "create_operation",
      "Create a new server operation (start, stop, restart, deploy, configure, status_check, custom).",
      {
        server_id: z.string(),
        operation_type: z.enum(["start", "stop", "restart", "deploy", "configure", "status_check", "custom"]),
        agent_id: z.string().optional(),
        session_id: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      },
      async ({ server_id, operation_type, agent_id, session_id, metadata }) => {
        try {
          const op = createOperation({ server_id, operation_type, agent_id, session_id, metadata });
          return { content: [{ type: "text" as const, text: `Created operation: ${op.operation_type} on ${server_id.slice(0, 8)} (${op.id.slice(0, 8)}, status: ${op.status})` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("get_operation")) {
    server.tool(
      "get_operation",
      "Get an operation by ID.",
      { id: z.string() },
      async ({ id }) => {
        try {
          const op = getOperation(id);
          if (!op) return { content: [{ type: "text" as const, text: `Operation not found: ${id}` }], isError: true };
          return { content: [{ type: "text" as const, text: JSON.stringify(op, null, 2) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("list_operations")) {
    server.tool(
      "list_operations",
      "List server operations.",
      {
        server_id: z.string().optional(),
        status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
        limit: z.number().int().positive().optional().default(DEFAULT_MCP_LIST_LIMIT),
        cursor: z.number().int().nonnegative().optional().default(0),
        verbose: z.boolean().optional().default(false).describe("Include session, completion, error, and metadata summary"),
      },
      async ({ server_id, status, limit, cursor, verbose }) => {
        try {
          const normalizedLimit = normalizeListLimit(limit);
          const normalizedCursor = normalizeCursor(cursor);
          const fetched = listOperations(server_id, status, normalizedCursor + normalizedLimit + 1);
          const ops = fetched.slice(normalizedCursor, normalizedCursor + normalizedLimit);
          if (ops.length === 0) {
            const text = normalizedCursor > 0 && fetched.length > 0
              ? `No operations at cursor ${normalizedCursor}; ${fetched.length} matching operation(s) exist before this page. Use cursor=0 or a smaller cursor.`
              : "No operations found.";
            return { content: [{ type: "text" as const, text }] };
          }
          const lines = ops.map(o => {
            const base = `${o.id.slice(0, 8)}  ${o.status.padEnd(11)} ${o.operation_type.padEnd(14)} server:${o.server_id.slice(0, 8)} agent:${truncateValue(o.agent_id, 20)}  ${o.started_at}`;
            if (!verbose) return base;
            return `${base} session:${truncateValue(o.session_id, 20)} completed:${truncateValue(o.completed_at, 24)} error:${truncateValue(o.error_message, 48)} metadata:${truncateValue(JSON.stringify(o.metadata), 64)}`;
          });
          return { content: [{ type: "text" as const, text: appendListFooter(lines.join("\n"), { shown: ops.length, nextCursor: fetched.length > normalizedCursor + normalizedLimit ? normalizedCursor + normalizedLimit : null, detailHint: "get_operation", verboseHint: !verbose }) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("start_operation")) {
    server.tool(
      "start_operation",
      "Mark an operation as running.",
      { id: z.string() },
      async ({ id }) => {
        try {
          const op = startOperation(id);
          return { content: [{ type: "text" as const, text: `Operation ${op.id.slice(0, 8)} started` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("complete_operation")) {
    server.tool(
      "complete_operation",
      "Mark an operation as completed.",
      { id: z.string() },
      async ({ id }) => {
        try {
          const op = completeOperation(id);
          return { content: [{ type: "text" as const, text: `Operation ${op.id.slice(0, 8)} completed` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("fail_operation")) {
    server.tool(
      "fail_operation",
      "Mark an operation as failed with an error message.",
      { id: z.string(), error_message: z.string() },
      async ({ id, error_message }) => {
        try {
          const op = failOperation(id, error_message);
          return { content: [{ type: "text" as const, text: `Operation ${op.id.slice(0, 8)} failed: ${error_message}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("cancel_operation")) {
    server.tool(
      "cancel_operation",
      "Cancel a pending or running operation.",
      { id: z.string() },
      async ({ id }) => {
        try {
          const op = cancelOperation(id);
          return { content: [{ type: "text" as const, text: `Operation ${op.id.slice(0, 8)} cancelled` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("delete_operation")) {
    server.tool(
      "delete_operation",
      "Delete an operation record.",
      { id: z.string() },
      async ({ id }) => {
        try {
          deleteOperation(id);
          return { content: [{ type: "text" as const, text: `Deleted operation ${id.slice(0, 8)}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }
}
