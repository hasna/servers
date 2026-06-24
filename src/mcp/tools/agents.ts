import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  registerAgent,
  getAgent,
  getAgentByName,
  getAgentBySession,
  listAgents,
  heartbeatAgent,
  archiveAgent,
  releaseAgent,
  updateAgent,
} from "../../db/agents.js";
import type { AgentConflictError } from "../../types/index.js";
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

export function registerAgentTools(server: McpServer, { shouldRegisterTool, formatError }: Helpers): void {

  if (shouldRegisterTool("register_agent")) {
    server.tool(
      "register_agent",
      "Register an agent with the servers system. Returns a conflict error if the name is already active.",
      {
        name: z.string().describe("Agent name (unique)"),
        description: z.string().optional(),
        capabilities: z.array(z.string()).optional().describe("Skills (e.g. ['typescript', 'devops'])"),
        session_id: z.string().optional().describe("Unique session ID for collision detection"),
        working_dir: z.string().optional().describe("Current working directory"),
        force: z.boolean().optional().describe("Take over a stale agent with this name"),
      },
      async ({ name, description, capabilities, session_id, working_dir, force }) => {
        try {
          const agent = registerAgent({ name, description, capabilities, session_id, working_dir, force });
          return { content: [{ type: "text" as const, text: `Registered: ${agent.name} (${agent.id.slice(0, 8)})` }] };
        } catch (e) {
          const conflict = e as AgentConflictError;
          if (conflict?.conflict) {
            return { content: [{ type: "text" as const, text: `Conflict: ${conflict.message}` }], isError: true };
          }
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }

  if (shouldRegisterTool("get_agent")) {
    server.tool(
      "get_agent",
      "Get an agent by ID or name.",
      { id_or_name: z.string().describe("Agent ID or name") },
      async ({ id_or_name }) => {
        try {
          let agent = getAgent(id_or_name);
          if (!agent) agent = getAgentByName(id_or_name);
          if (!agent) return { content: [{ type: "text" as const, text: `Agent not found: ${id_or_name}` }], isError: true };
          return { content: [{ type: "text" as const, text: JSON.stringify(agent, null, 2) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("list_agents")) {
    server.tool(
      "list_agents",
      "List registered agents.",
      {
        status: z.enum(["active", "archived"]).optional(),
        limit: z.number().int().positive().optional().default(DEFAULT_MCP_LIST_LIMIT),
        cursor: z.number().int().nonnegative().optional().default(0),
        verbose: z.boolean().optional().default(false).describe("Include working directory, capabilities, and description"),
      },
      async ({ status, limit, cursor, verbose }) => {
        try {
          const agents = listAgents(status);
          if (agents.length === 0) return { content: [{ type: "text" as const, text: "No agents found." }] };
          const page = pageItems(agents, normalizeListLimit(limit), normalizeCursor(cursor));
          const lines = page.rows.map(a => {
            const base = `${a.id.slice(0, 8)}  ${a.status.padEnd(10)} ${truncateValue(a.name, 24).padEnd(24)} session:${truncateValue(a.session_id, 24)}  last:${a.last_seen_at}`;
            if (!verbose) return base;
            return `${base}  cwd:${truncateValue(a.working_dir, 48)} caps:${truncateValue(a.capabilities.join(","), 48)} desc:${truncateValue(a.description, 48)}`;
          });
          return { content: [{ type: "text" as const, text: appendListFooter(lines.join("\n"), { shown: page.rows.length, total: page.total, nextCursor: page.nextCursor, detailHint: "get_agent", verboseHint: !verbose }) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("agent_heartbeat")) {
    server.tool(
      "agent_heartbeat",
      "Update an agent's last_seen timestamp.",
      { agent_id: z.string() },
      async ({ agent_id }) => {
        try {
          const agent = heartbeatAgent(agent_id);
          return { content: [{ type: "text" as const, text: `Heartbeat: ${agent.name} at ${agent.last_seen_at}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("archive_agent")) {
    server.tool(
      "archive_agent",
      "Archive an agent (set status to archived, clear session).",
      { agent_id: z.string() },
      async ({ agent_id }) => {
        try {
          archiveAgent(agent_id);
          return { content: [{ type: "text" as const, text: `Archived agent ${agent_id.slice(0, 8)}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("release_agent")) {
    server.tool(
      "release_agent",
      "Release an agent's session (clear session_id but keep agent active).",
      { agent_id: z.string() },
      async ({ agent_id }) => {
        try {
          const agent = releaseAgent(agent_id);
          return { content: [{ type: "text" as const, text: `Released: ${agent.name}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }
}
