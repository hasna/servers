import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getStorageStatus,
  storagePull,
  storagePush,
  storageSync,
} from "../../db/storage-sync.js";

type Helpers = {
  shouldRegisterTool: (name: string) => boolean;
  formatError: (e: unknown) => string;
};

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerStorageTools(server: McpServer, { shouldRegisterTool, formatError }: Helpers): void {
  if (shouldRegisterTool("storage_status")) {
    server.tool(
      "storage_status",
      "Show servers storage sync configuration and local sync history.",
      {},
      async () => {
        try {
          return jsonResult(getStorageStatus());
        } catch (e) {
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }

  if (shouldRegisterTool("storage_push")) {
    server.tool(
      "storage_push",
      "Push local servers data to storage PostgreSQL.",
      { tables: z.array(z.string()).optional() },
      async ({ tables }) => {
        try {
          return jsonResult(await storagePush(tables ? { tables } : undefined));
        } catch (e) {
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }

  if (shouldRegisterTool("storage_pull")) {
    server.tool(
      "storage_pull",
      "Pull servers data from storage PostgreSQL to local SQLite.",
      { tables: z.array(z.string()).optional() },
      async ({ tables }) => {
        try {
          return jsonResult(await storagePull(tables ? { tables } : undefined));
        } catch (e) {
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }

  if (shouldRegisterTool("storage_sync")) {
    server.tool(
      "storage_sync",
      "Bidirectional servers sync: pull then push.",
      { tables: z.array(z.string()).optional() },
      async ({ tables }) => {
        try {
          return jsonResult(await storageSync(tables ? { tables } : undefined));
        } catch (e) {
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }
}
