import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDatabase, now, resolvePartialId } from "../../db/database.js";
import { createServer, getServer, getServerBySlug, updateServer } from "../../db/servers.js";
import {
  detectProjectServerConfig,
  displayNameForServerConfig,
  getLocalServerSnapshot,
  restartLocalServer,
  startLocalServer,
  stopLocalServer,
  type LocalLifecycleOptions,
} from "../../runtime/local-server.js";
import type { Server } from "../../types/index.js";

type Helpers = {
  shouldRegisterTool: (name: string) => boolean;
  resolveId: (id: string, table?: string) => string;
  formatError: (e: unknown) => string;
};

const lifecycleShape = {
  id_or_slug: z.string().describe("Server UUID, UUID prefix, name, or slug"),
  agent_id: z.string().optional().describe("Agent claiming the lifecycle operation"),
  session_id: z.string().optional(),
  reason: z.string().optional().describe("Why this lifecycle action is being performed"),
  command: z.string().optional().describe("Override start command for this run"),
  cwd: z.string().optional().describe("Override working directory for this run"),
  port: z.number().int().positive().optional(),
  health_url: z.string().url().optional(),
  env: z.record(z.string()).optional().describe("Additional environment variables for the process"),
  log_file: z.string().optional(),
  wait: z.boolean().optional().default(true),
  wait_for_lock: z.boolean().optional().default(false),
  timeout_ms: z.number().int().positive().optional().describe("Readiness timeout for start/restart"),
  lock_timeout_ms: z.number().int().positive().optional(),
  stop_timeout_ms: z.number().int().positive().optional(),
  force: z.boolean().optional(),
};

function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
}

function resolveServer(idOrSlug: string): Server {
  const db = getDatabase();
  let server = getServer(idOrSlug, db) || getServerBySlug(idOrSlug, db);
  if (!server) {
    const resolved = resolvePartialId(db, "servers", idOrSlug);
    if (resolved) server = getServer(resolved, db);
  }
  if (!server) throw new Error(`Server not found: ${idOrSlug}`);
  return server;
}

function lifecycleOptions(input: z.infer<z.ZodObject<typeof lifecycleShape>>): LocalLifecycleOptions {
  return {
    agentId: input.agent_id,
    sessionId: input.session_id,
    reason: input.reason,
    command: input.command,
    cwd: input.cwd,
    port: input.port,
    healthUrl: input.health_url,
    env: input.env,
    wait: input.wait,
    waitForLock: input.wait_for_lock,
    lockTimeoutMs: input.lock_timeout_ms,
    readyTimeoutMs: input.timeout_ms,
    stopTimeoutMs: input.stop_timeout_ms,
    logFile: input.log_file,
    force: input.force,
  };
}

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerLifecycleTools(server: McpServer, { shouldRegisterTool, formatError }: Helpers): void {
  if (shouldRegisterTool("init_local_server")) {
    server.tool(
      "init_local_server",
      "Detect or configure a local app server record that can later be started with start_local_server.",
      {
        name: z.string().optional(),
        path: z.string().optional().describe("Project/app directory. Defaults to current working directory."),
        project_id: z.string().optional(),
        description: z.string().optional(),
        command: z.string().optional(),
        port: z.number().int().positive().optional(),
        health_url: z.string().url().optional(),
        env: z.record(z.string()).optional(),
        log_file: z.string().optional(),
        force: z.boolean().optional().default(false).describe("Update an existing server with the same slug"),
      },
      async ({ name, path, project_id, description, command, port, health_url, env, log_file, force }) => {
        try {
          const detected = command
            ? {
                command,
                cwd: path ?? process.cwd(),
                port,
                healthUrl: health_url,
                metadata: { detected_from: "mcp:command" },
              }
            : detectProjectServerConfig(path ?? process.cwd(), { port, healthUrl: health_url });
          const serverName = name ?? displayNameForServerConfig(detected.cwd);
          const metadata = {
            ...detected.metadata,
            start_command: detected.command,
            command: detected.command,
            cwd: detected.cwd,
            port: detected.port,
            tailscale_port: detected.port,
            health_url: detected.healthUrl,
            env: env ?? {},
            log_file,
            configured_at: now(),
          };
          const slug = slugFromName(serverName);
          const existing = getServerBySlug(slug);
          const localServer = existing
            ? force
              ? updateServer(existing.id, {
                  name: serverName,
                  path: detected.cwd,
                  description: description ?? existing.description,
                  metadata: { ...existing.metadata, ...metadata },
                  project_id,
                })
              : existing
            : createServer({
                name: serverName,
                path: detected.cwd,
                description,
                status: "offline",
                metadata,
                project_id,
              });
          return jsonText({ server: localServer, command: detected.command, cwd: detected.cwd, existed: Boolean(existing) });
        } catch (e) {
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }

  if (shouldRegisterTool("start_local_server")) {
    server.tool(
      "start_local_server",
      "Safely start a local app server with a lifecycle lock, operation record, readiness wait, and trace.",
      lifecycleShape,
      async (input) => {
        try {
          return jsonText(await startLocalServer(input.id_or_slug, lifecycleOptions(input)));
        } catch (e) {
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }

  if (shouldRegisterTool("stop_local_server")) {
    server.tool(
      "stop_local_server",
      "Safely stop a local app server with a lifecycle lock, operation record, and trace.",
      lifecycleShape,
      async (input) => {
        try {
          return jsonText(await stopLocalServer(input.id_or_slug, lifecycleOptions(input)));
        } catch (e) {
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }

  if (shouldRegisterTool("restart_local_server")) {
    server.tool(
      "restart_local_server",
      "Safely restart a local app server with a lifecycle lock, operation record, readiness wait, and trace.",
      lifecycleShape,
      async (input) => {
        try {
          return jsonText(await restartLocalServer(input.id_or_slug, lifecycleOptions(input)));
        } catch (e) {
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }

  if (shouldRegisterTool("get_local_server_status")) {
    server.tool(
      "get_local_server_status",
      "Check the observed local process/readiness state for a managed app server.",
      {
        id_or_slug: z.string(),
        timeout_ms: z.number().int().positive().optional().default(1000),
        refresh: z.boolean().optional().default(false).describe("Persist observed online/offline status and heartbeat"),
      },
      async ({ id_or_slug, timeout_ms, refresh }) => {
        try {
          const localServer = resolveServer(id_or_slug);
          const snapshot = await getLocalServerSnapshot(localServer, { timeoutMs: timeout_ms });
          const updated = refresh
            ? updateServer(localServer.id, {
                status: snapshot.status,
                last_heartbeat: snapshot.ready ? now() : undefined,
              })
            : localServer;
          return jsonText({ server: updated, snapshot });
        } catch (e) {
          return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
        }
      },
    );
  }
}
