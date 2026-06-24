import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createProject, getProject, getProjectByPath, listProjects, updateProject, deleteProject } from "../../db/projects.js";
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

export function registerProjectTools(server: McpServer, { shouldRegisterTool, formatError }: Helpers): void {

  if (shouldRegisterTool("create_project")) {
    server.tool(
      "create_project",
      "Register a project.",
      {
        name: z.string().describe("Project name (unique)"),
        path: z.string().describe("Project path (unique)"),
        description: z.string().optional(),
      },
      async ({ name, path, description }) => {
        try {
          const project = createProject({ name, path, description });
          return { content: [{ type: "text" as const, text: `Created project: ${project.name} (${project.id.slice(0, 8)})` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("get_project")) {
    server.tool(
      "get_project",
      "Get a project by ID or path.",
      { id_or_path: z.string() },
      async ({ id_or_path }) => {
        try {
          let project = getProject(id_or_path);
          if (!project) project = getProjectByPath(id_or_path);
          if (!project) return { content: [{ type: "text" as const, text: `Project not found: ${id_or_path}` }], isError: true };
          return { content: [{ type: "text" as const, text: JSON.stringify(project, null, 2) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("list_projects")) {
    server.tool(
      "list_projects",
      "List all projects.",
      {
        limit: z.number().int().positive().optional().default(DEFAULT_MCP_LIST_LIMIT),
        cursor: z.number().int().nonnegative().optional().default(0),
        verbose: z.boolean().optional().default(false).describe("Include description and timestamps"),
      },
      async ({ limit, cursor, verbose }) => {
        try {
          const projects = listProjects();
          if (projects.length === 0) return { content: [{ type: "text" as const, text: "No projects found." }] };
          const page = pageItems(projects, normalizeListLimit(limit), normalizeCursor(cursor));
          const lines = page.rows.map(p => {
            const base = `${p.id.slice(0, 8)}  ${truncateValue(p.name, 24).padEnd(24)} ${truncateValue(p.path, 64)}`;
            if (!verbose) return base;
            return `${base} desc:${truncateValue(p.description, 48)} created:${p.created_at} updated:${p.updated_at}`;
          });
          return { content: [{ type: "text" as const, text: appendListFooter(lines.join("\n"), { shown: page.rows.length, total: page.total, nextCursor: page.nextCursor, detailHint: "get_project", verboseHint: !verbose }) }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("update_project")) {
    server.tool(
      "update_project",
      "Update a project.",
      {
        id: z.string(),
        name: z.string().optional(),
        path: z.string().optional(),
        description: z.string().nullable().optional(),
      },
      async ({ id, ...rest }) => {
        try {
          const project = updateProject(id, rest as any);
          return { content: [{ type: "text" as const, text: `Updated: ${project.name}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }

  if (shouldRegisterTool("delete_project")) {
    server.tool(
      "delete_project",
      "Delete a project.",
      { id: z.string() },
      async ({ id }) => {
        try {
          deleteProject(id);
          return { content: [{ type: "text" as const, text: `Deleted project ${id.slice(0, 8)}` }] };
        } catch (e) { return { content: [{ type: "text" as const, text: formatError(e) }], isError: true }; }
      },
    );
  }
}
