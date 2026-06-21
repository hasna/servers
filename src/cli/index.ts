#!/usr/bin/env bun
import { Command } from "commander";
import { registerEventsCommands } from "@hasna/events/commander";
import { readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import chalk from "chalk";
import {
  getDatabase,
  closeDatabase,
  resolvePartialId,
  LOCK_EXPIRY_MINUTES,
  now,
} from "../db/database.js";
import { ensureSchema } from "../db/schema.js";
import {
  listServers,
  getServer,
  getServerBySlug,
  createServer,
  updateServer,
  deleteServer,
  lockServer,
  unlockServer,
  heartbeatServer,
} from "../db/servers.js";
import {
  listAgents,
  registerAgent,
  getAgentByName,
  updateAgent,
  heartbeatAgent,
  archiveAgent,
  releaseAgent,
} from "../db/agents.js";
import {
  listOperations,
  createOperation,
  getOperation,
  updateOperation,
  startOperation,
  completeOperation,
  failOperation,
  cancelOperation,
  deleteOperation,
} from "../db/operations.js";
import {
  listTraces,
  listTracesByAgent,
  createTrace,
  deleteTracesByServer,
} from "../db/traces.js";
import {
  listProjects,
  createProject,
  getProjectByPath,
} from "../db/projects.js";
import {
  listWebhooks,
  listDeliveries,
  createWebhook,
  getWebhook,
  deleteWebhook,
  dispatchWebhook,
} from "../db/webhooks.js";
import { getTailscaleUrl } from "../utils/tailscale.js";
import {
  detectProjectServerConfig,
  displayNameForServerConfig,
  getLocalServerSnapshot,
  restartLocalServer,
  startLocalServer,
  stopLocalServer,
} from "../runtime/local-server.js";
import type { Server, UpdateServerInput } from "../types/index.js";
import { parseStrictInteger, type StrictIntegerOptions } from "../utils/integers.js";

function getVersion(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(__dir, "..", "..", "package.json"),
      join(__dir, "..", "package.json"),
    ];
    for (const pkgPath of candidates) {
      if (existsSync(pkgPath)) {
        return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
      }
    }
    return "0.0.0";
  } catch { return "0.0.0"; }
}

async function emitWebhook(event: string, payload: Record<string, unknown>, db: ReturnType<typeof initDb>): Promise<void> {
  await dispatchWebhook(event, payload, db);
}

function initDb(opts?: { db?: string }) {
  if (opts?.db) process.env["SERVERS_DB_PATH"] = opts.db;
  const db = getDatabase();
  ensureSchema(db);
  return db;
}

function findNearestGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Whether the caller asked for JSON output. Honors BOTH the per-command
 * `--json` flag and the global `--format json` option. The global `--format`
 * lives on the root program, so it is not merged into a subcommand's own opts
 * — read it from the program directly.
 */
function wantsJson(opts: Record<string, any>): boolean {
  if (opts?.json) return true;
  if (opts?.format === "json") return true;
  try {
    return program.opts().format === "json";
  } catch {
    return false;
  }
}

const REDACTED_VALUE = "[redacted]";
const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(secret|token|key|password|passwd|credential|authorization|auth|cookie|session|private)(?:$|[_-])/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || /api[_-]?key/i.test(key) || /access[_-]?token/i.test(key) || /refresh[_-]?token/i.test(key);
}

function redactSensitiveString(value: string): string {
  return value
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, "$1[redacted]")
    .replace(/([?&][^=\s&]*(?:secret|token|key|password|passwd|credential|auth)[^=\s&]*=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]");
}

function redactSensitiveFields<T>(value: T): T {
  if (typeof value === "string") {
    return redactSensitiveString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSensitiveKey(key) && child != null ? REDACTED_VALUE : redactSensitiveFields(child);
  }

  return redacted as T;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(redactSensitiveFields(value), null, 2));
}

function stringifyForDisplay(value: unknown): string {
  return JSON.stringify(redactSensitiveFields(value));
}

function formatTable(headers: string[], rows: string[][]): string {
  const cols = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]?.length ?? 0)));
  const pad = cols.map(c => c + 2);
  const header = headers.map((h, i) => h.padEnd(pad[i])).join("").trimEnd();
  const separator = cols.map(c => "─".repeat(c + 2)).join("").trimEnd();
  const body = rows.map(r => r.map((cell, i) => cell.padEnd(pad[i])).join("").trimEnd()).join("\n");
  return `${header}\n${separator}\n${body}`;
}

function parseJsonObject(value: string, optionName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    console.error(chalk.red(`${optionName} must be a valid JSON object`));
    process.exit(1);
  }
}

function buildServerMetadata(opts: {
  metadata?: string;
  tailscaleHostname?: string;
  tailscalePort?: string;
}): Record<string, unknown> | undefined {
  const metadata = opts.metadata ? parseJsonObject(opts.metadata, "--metadata") : {};

  if (opts.tailscaleHostname !== undefined) {
    metadata.tailscale_hostname = opts.tailscaleHostname;
  }

  if (opts.tailscalePort !== undefined) {
    const port = parseIntegerOption(opts.tailscalePort, "--tailscale-port", { min: 1, max: 65535 });
    metadata.tailscale_port = port;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function serverWithComputedFields(server: Server): Server & { tailscale_url: string | null } {
  return {
    ...server,
    tailscale_url: getTailscaleUrl(server),
  };
}

function collectValue(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseIntegerOption(value: string | undefined, optionName: string, options: StrictIntegerOptions = {}): number | undefined {
  if (value === undefined) return undefined;
  try {
    return parseStrictInteger(value, optionName, options);
  } catch (error: any) {
    console.error(chalk.red(error.message));
    process.exit(1);
  }
}

function parsePortOption(value: string | undefined, optionName: string): number | undefined {
  return parseIntegerOption(value, optionName, { min: 1, max: 65535 });
}

function parsePositiveIntegerOption(value: string | undefined, optionName: string): number | undefined {
  return parseIntegerOption(value, optionName, { min: 1 });
}

function parseEnvOptions(values?: string[]): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) {
      console.error(chalk.red(`--env must use KEY=VALUE syntax: ${value}`));
      process.exit(1);
    }
    const key = value.slice(0, index);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      console.error(chalk.red(`Invalid environment variable name: ${key}`));
      process.exit(1);
    }
    env[key] = value.slice(index + 1);
  }
  return env;
}

function resolveServerOrExit(idOrSlug: string, db: ReturnType<typeof initDb>): Server {
  let server = getServer(idOrSlug, db);
  if (!server) server = getServerBySlug(idOrSlug, db);
  if (!server) {
    const resolved = resolvePartialId(db, "servers", idOrSlug);
    if (resolved) server = getServer(resolved, db);
  }
  if (!server) {
    console.error(chalk.red(`Server not found: ${idOrSlug}`));
    process.exit(1);
  }
  return server;
}

function lifecycleOptions(opts: Record<string, any>) {
  return {
    agentId: opts.agent,
    sessionId: opts.session,
    reason: opts.reason,
    command: opts.command,
    cwd: opts.cwd,
    port: parsePortOption(opts.port, "--port"),
    healthUrl: opts.healthUrl,
    env: parseEnvOptions(opts.env),
    wait: opts.wait,
    waitForLock: Boolean(opts.waitLock),
    lockTimeoutMs: parsePositiveIntegerOption(opts.lockTimeout, "--lock-timeout"),
    readyTimeoutMs: parsePositiveIntegerOption(opts.timeout, "--timeout"),
    stopTimeoutMs: parsePositiveIntegerOption(opts.stopTimeout || opts.timeout, opts.stopTimeout ? "--stop-timeout" : "--timeout"),
    logFile: opts.logFile,
    force: opts.force,
  };
}

// ── Program ──────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("servers")
  .description("Server management for AI coding agents")
  .version(getVersion())
  .option("--db <path>", "Path to SQLite database")
  .option("--format <format>", "Output format (table, json)", "table")
  .hook("preAction", (thisCmd) => {
    const opts = thisCmd.optsWithGlobals();
    if (opts.db) process.env["SERVERS_DB_PATH"] = opts.db;
  });
registerEventsCommands(program, { source: "servers", webhooksCommandName: "event-webhooks" });

// ── Dashboard (default) ──────────────────────────────────────────────────────

program
  .action((opts) => {
    const db = initDb(opts);
    const servers = listServers(undefined, db);
    const agents = listAgents("active", db);
    const ops = listOperations(undefined, undefined, 10, db);
    const traces = listTraces(undefined, undefined, 5, db);

    if (wantsJson(opts)) {
      printJson({ servers: servers.map(serverWithComputedFields), agents, operations: ops, traces });
      closeDatabase();
      return;
    }

    const statusCounts: Record<string, number> = {};
    for (const s of servers) {
      statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
    }

    console.log(chalk.bold("\n  Server Status"));
    console.log(`  Total: ${servers.length}`);
    for (const [status, count] of Object.entries(statusCounts)) {
      const color = status === "online" ? chalk.green : status === "offline" ? chalk.red : chalk.yellow;
      console.log(`    ${color(status)}: ${count}`);
    }

    if (servers.length === 0) console.log("    (no servers registered)");

    console.log(chalk.bold(`\n  Agents (${agents.length})`));
    for (const a of agents) {
      console.log(`    ${chalk.bold(a.name.padEnd(20))} session: ${a.session_id || "-"}  last: ${a.last_seen_at}`);
    }
    if (agents.length === 0) console.log("    (no active agents)");

    console.log(chalk.bold(`\n  Recent Operations (${ops.length})`));
    for (const o of ops) {
      console.log(`    ${o.id.slice(0, 8)}  ${o.status.padEnd(11)} ${o.operation_type.padEnd(14)} server:${o.server_id.slice(0, 8)}`);
    }
    if (ops.length === 0) console.log("    (no operations)");

    console.log(chalk.bold(`\n  Recent Traces (${traces.length})`));
    for (const t of traces) {
      console.log(`    ${t.event.padEnd(30)} server:${t.server_id.slice(0, 8)}  ${t.agent_id || "-"}`);
    }
    if (traces.length === 0) console.log("    (no traces)");
    console.log("");
    closeDatabase();
  });

// ── Servers ──────────────────────────────────────────────────────────────────

program
  .command("servers")
  .alias("server")
  .description("List registered servers")
  .option("-p, --project <id>", "Filter by project")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = initDb(opts);
    const servers = listServers(opts.project, db);
    if (wantsJson(opts)) {
      printJson(servers.map(serverWithComputedFields));
    } else {
      const headers = ["ID", "STATUS", "NAME", "SLUG", "HOSTNAME", "TAILSCALE URL"];
      const rows = servers.map(s => [
        s.id.slice(0, 8),
        s.status === "online" ? chalk.green(s.status) : s.status === "offline" ? chalk.red(s.status) : chalk.yellow(s.status),
        chalk.bold(s.name),
        s.slug,
        s.hostname || "-",
        getTailscaleUrl(s) || "-",
      ]);
      console.log(formatTable(headers, rows.length > 0 ? rows : [["(none)", "", "", "", "", ""]]));
    }
    closeDatabase();
  });

program
  .command("servers:add")
  .alias("server:add")
  .description("Register a new server")
  .requiredOption("-n, --name <name>", "Server name")
  .option("--slug <slug>", "URL-friendly slug")
  .option("--hostname <hostname>", "Hostname or IP")
  .option("--path <path>", "SSH or local path")
  .option("--description <desc>", "Description")
  .option("--status <status>", "Initial status (default: unknown)")
  .option("--project <id>", "Project ID")
  .option("--metadata <json>", "Server metadata as a JSON object")
  .option("--tailscale-hostname <name>", "Tailscale machine name for URL output")
  .option("--tailscale-port <port>", "Port for Tailscale URL output")
  .action(async (opts) => {
    const db = initDb(opts);
    const metadata = buildServerMetadata(opts);
    const server = createServer({
      name: opts.name,
      slug: opts.slug,
      hostname: opts.hostname,
      path: opts.path,
      description: opts.description,
      status: opts.status,
      metadata,
      project_id: opts.project,
    }, db);
    await emitWebhook("server.created", { server_id: server.id, project_id: server.project_id, server }, db);
    console.log(chalk.green(`Created server: ${server.name} (${server.slug}, id: ${server.id.slice(0, 8)})`));
    closeDatabase();
  });

program
  .command("servers:update")
  .alias("server:update")
  .description("Update a server")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--name <name>", "New name")
  .option("--slug <slug>", "New slug")
  .option("--hostname <hostname>", "Hostname or IP")
  .option("--path <path>", "SSH or local path")
  .option("--description <desc>", "Description")
  .option("--status <status>", "New status")
  .option("--project <id>", "Project ID")
  .option("--metadata <json>", "Replace server metadata with a JSON object")
  .option("--tailscale-hostname <name>", "Set Tailscale machine name for URL output")
  .option("--tailscale-port <port>", "Set port for Tailscale URL output")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    let server = getServer(idOrSlug, db);
    if (!server) server = getServerBySlug(idOrSlug, db);
    if (!server) {
      const resolved = resolvePartialId(db, "servers", idOrSlug);
      if (resolved) server = getServer(resolved, db);
    }
    if (!server) {
      console.error(chalk.red(`Server not found: ${idOrSlug}`));
      process.exit(1);
    }
    const update: UpdateServerInput = {};
    if (opts.name !== undefined) update.name = opts.name;
    if (opts.slug !== undefined) update.slug = opts.slug;
    if (opts.hostname !== undefined) update.hostname = opts.hostname;
    if (opts.path !== undefined) update.path = opts.path;
    if (opts.description !== undefined) update.description = opts.description;
    if (opts.status !== undefined) update.status = opts.status;
    if (opts.project !== undefined) update.project_id = opts.project;
    const metadataPatch = buildServerMetadata(opts);
    if (metadataPatch !== undefined) {
      update.metadata = {
        ...server.metadata,
        ...metadataPatch,
      };
    }
    if (Object.keys(update).length === 0) {
      console.error(chalk.yellow("No fields to update. Use --name, --status, --metadata, --tailscale-hostname, etc."));
      process.exit(1);
    }
    const updated = updateServer(server.id, update as any, db);
    await emitWebhook("server.updated", { server_id: updated.id, project_id: updated.project_id, server: updated, changes: update }, db);
    console.log(chalk.green(`Updated server: ${updated.name}`));
    closeDatabase();
  });

program
  .command("servers:get")
  .alias("server:get")
  .description("Get server details")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--json", "Output as JSON")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    let server = getServer(idOrSlug, db);
    if (!server) server = getServerBySlug(idOrSlug, db);
    if (!server) {
      const resolved = resolvePartialId(db, "servers", idOrSlug);
      if (resolved) server = getServer(resolved, db);
    }
    if (!server) {
      console.error(chalk.red(`Server not found: ${idOrSlug}`));
      process.exit(1);
    }
    const output = serverWithComputedFields(server);
    if (wantsJson(opts)) {
      printJson(output);
    } else {
      console.log(chalk.bold("Server:"));
      console.log(`  ID:          ${server.id}`);
      console.log(`  Name:        ${server.name}`);
      console.log(`  Slug:        ${server.slug}`);
      console.log(`  Status:      ${server.status}`);
      console.log(`  Hostname:    ${server.hostname || "-"}`);
      console.log(`  Tailscale:   ${output.tailscale_url || "-"}`);
      console.log(`  Path:        ${server.path || "-"}`);
      console.log(`  Project:     ${server.project_id || "-"}`);
      console.log(`  Locked by:   ${server.locked_by || "-"}`);
      console.log(`  Heartbeat:   ${server.last_heartbeat || "-"}`);
      console.log(`  Description: ${server.description || "-"}`);
    }
    closeDatabase();
  });

program
  .command("servers:delete")
  .alias("server:delete")
  .description("Delete a server (must not be locked)")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    let server = getServer(idOrSlug, db);
    if (!server) server = getServerBySlug(idOrSlug, db);
    if (!server) {
      const resolved = resolvePartialId(db, "servers", idOrSlug);
      if (resolved) server = getServer(resolved, db);
    }
    if (!server) {
      console.error(chalk.red(`Server not found: ${idOrSlug}`));
      process.exit(1);
    }
    deleteServer(server.id, db);
    await emitWebhook("server.deleted", { server_id: server.id, project_id: server.project_id, server }, db);
    console.log(chalk.green(`Deleted server: ${server.name}`));
    closeDatabase();
  });

program
  .command("servers:lock")
  .alias("server:lock")
  .description("Lock a server (prevent modifications)")
  .requiredOption("--agent <id>", "Agent ID requesting lock")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    let server = getServer(idOrSlug, db);
    if (!server) server = getServerBySlug(idOrSlug, db);
    if (!server) {
      const resolved = resolvePartialId(db, "servers", idOrSlug);
      if (resolved) server = getServer(resolved, db);
    }
    if (!server) {
      console.error(chalk.red(`Server not found: ${idOrSlug}`));
      process.exit(1);
    }
    try {
      const locked = lockServer(server.id, opts.agent, db);
      await emitWebhook("server.locked", { server_id: locked.id, project_id: locked.project_id, agent_id: opts.agent, server: locked }, db);
      console.log(chalk.green(`Locked server: ${locked.name} by ${locked.locked_by}`));
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    closeDatabase();
  });

program
  .command("servers:unlock")
  .alias("server:unlock")
  .description("Unlock a server")
  .requiredOption("--agent <id>", "Agent ID that holds the lock")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    let server = getServer(idOrSlug, db);
    if (!server) server = getServerBySlug(idOrSlug, db);
    if (!server) {
      const resolved = resolvePartialId(db, "servers", idOrSlug);
      if (resolved) server = getServer(resolved, db);
    }
    if (!server) {
      console.error(chalk.red(`Server not found: ${idOrSlug}`));
      process.exit(1);
    }
    try {
      const unlocked = unlockServer(server.id, opts.agent, db);
      await emitWebhook("server.unlocked", { server_id: unlocked.id, project_id: unlocked.project_id, agent_id: opts.agent, server: unlocked }, db);
      console.log(chalk.green(`Unlocked server: ${unlocked.name}`));
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    closeDatabase();
  });

// ── Agents ───────────────────────────────────────────────────────────────────

program
  .command("agents")
  .description("List registered agents")
  .option("--json", "Output as JSON")
  .option("--status <status>", "Filter by status (active/archived)")
  .action((opts) => {
    const db = initDb(opts);
    const agents = listAgents(opts.status, db);
    if (wantsJson(opts)) {
      printJson(agents);
    } else {
      const headers = ["ID", "STATUS", "NAME", "SESSION", "LAST SEEN"];
      const rows = agents.map(a => [
        a.id.slice(0, 8),
        a.status === "active" ? chalk.green(a.status) : chalk.yellow(a.status),
        chalk.bold(a.name),
        a.session_id || "-",
        a.last_seen_at,
      ]);
      console.log(formatTable(headers, rows.length > 0 ? rows : [["(none)", "", "", "", ""]]));
    }
    closeDatabase();
  });

program
  .command("agent:register")
  .description("Register an agent")
  .requiredOption("-n, --name <name>", "Agent name")
  .option("--description <desc>", "Description")
  .option("--capabilities <caps>", "Comma-separated capabilities")
  .option("--session <id>", "Session ID")
  .option("--working-dir <dir>", "Working directory (default: current dir)")
  .action(async (opts) => {
    const db = initDb(opts);
    const workingDir = opts.workingDir || process.cwd();
    const agent = registerAgent({
      name: opts.name,
      description: opts.description,
      capabilities: opts.capabilities?.split(",").map((s: string) => s.trim()),
      session_id: opts.session,
      working_dir: workingDir,
    }, db);
    await emitWebhook("agent.registered", { agent_id: agent.id, agent }, db);
    console.log(chalk.green(`Registered: ${agent.name} (${agent.id.slice(0, 8)})`));
    closeDatabase();
  });

program
  .command("agent:update")
  .description("Update an agent")
  .argument("<name>", "Agent name")
  .option("--description <desc>", "New description")
  .option("--capabilities <caps>", "New comma-separated capabilities")
  .option("--session <id>", "New session ID")
  .option("--working-dir <dir>", "New working directory")
  .action(async (name, opts) => {
    const db = initDb(opts);
    const agent = getAgentByName(name, db);
    if (!agent) {
      console.error(chalk.red(`Agent not found: ${name}`));
      process.exit(1);
    }
    const update: Record<string, unknown> = {};
    if (opts.description !== undefined) update.description = opts.description;
    if (opts.capabilities !== undefined) update.capabilities = opts.capabilities.split(",").map((s: string) => s.trim());
    if (opts.session !== undefined) update.session_id = opts.session;
    if (opts.workingDir !== undefined) update.working_dir = opts.workingDir;
    if (Object.keys(update).length === 0) {
      console.error(chalk.yellow("No fields to update. Use --description, --capabilities, etc."));
      process.exit(1);
    }
    const updated = updateAgent(agent.id, update as any, db);
    await emitWebhook("agent.updated", { agent_id: updated.id, agent: updated, changes: update }, db);
    console.log(chalk.green(`Updated agent: ${updated.name}`));
    closeDatabase();
  });

program
  .command("agent:heartbeat")
  .description("Send a heartbeat for an agent")
  .argument("<name>", "Agent name or ID")
  .action(async (name, opts) => {
    const db = initDb(opts);
    const agent = getAgentByName(name, db);
    if (!agent) {
      console.error(chalk.red(`Agent not found: ${name}`));
      process.exit(1);
    }
    const updated = heartbeatAgent(agent.id, db);
    await emitWebhook("agent.heartbeat", { agent_id: updated.id, agent: updated }, db);
    console.log(chalk.green(`Heartbeat: ${updated.name} last seen at ${updated.last_seen_at}`));
    closeDatabase();
  });

// ── Operations ───────────────────────────────────────────────────────────────

program
  .command("operations")
  .description("List server operations")
  .option("-s, --server <id>", "Filter by server")
  .option("--status <status>", "Filter by status")
  .option("-l, --limit <n>", "Limit results", "50")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = initDb(opts);
    // Resolve partial server ID if given
    let serverId = opts.server;
    if (serverId && serverId.length < 36) {
      const resolved = resolvePartialId(db, "servers", serverId);
      if (resolved) serverId = resolved;
    }
    const ops = listOperations(serverId, opts.status, parsePositiveIntegerOption(opts.limit, "--limit") ?? 50, db);
    if (wantsJson(opts)) {
      printJson(ops);
    } else {
      const headers = ["ID", "STATUS", "TYPE", "SERVER", "AGENT", "STARTED"];
      const rows = ops.map(o => [
        o.id.slice(0, 8),
        o.status === "completed" ? chalk.green(o.status) : o.status === "failed" ? chalk.red(o.status) : chalk.yellow(o.status),
        o.operation_type,
        o.server_id.slice(0, 8),
        o.agent_id || "-",
        o.started_at,
      ]);
      console.log(formatTable(headers, rows.length > 0 ? rows : [["(none)", "", "", "", "", ""]]));
    }
    closeDatabase();
  });

program
  .command("operation:add")
  .description("Create a new operation")
  .requiredOption("--server <id>", "Server ID, partial ID, or slug")
  .requiredOption("--type <type>", "Operation type (start, stop, restart, deploy, configure, status_check, custom)")
  .option("--agent <id>", "Agent ID")
  .option("--session <id>", "Session ID")
  .action(async (opts) => {
    const db = initDb(opts);
    // Resolve partial ID
    let serverId = opts.server;
    if (serverId.length < 36) {
      const resolved = resolvePartialId(db, "servers", serverId);
      if (resolved) serverId = resolved;
    }
    const op = createOperation({
      server_id: serverId,
      operation_type: opts.type,
      agent_id: opts.agent,
      session_id: opts.session,
    }, db);
    await emitWebhook("operation.created", { operation_id: op.id, server_id: op.server_id, agent_id: op.agent_id, operation: op }, db);
    console.log(chalk.green(`Created operation: ${op.id.slice(0, 8)} (${op.operation_type}) on server ${serverId.slice(0, 8)}`));
    closeDatabase();
  });

program
  .command("operation:start")
  .description("Start a pending operation")
  .argument("<id>", "Operation ID")
  .action(async (id, opts) => {
    const db = initDb(opts);
    try {
      const started = startOperation(id, db);
      await emitWebhook("operation.started", { operation_id: started.id, server_id: started.server_id, agent_id: started.agent_id, operation: started }, db);
      console.log(chalk.green(`Started: ${started.id.slice(0, 8)} → running`));
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    closeDatabase();
  });

program
  .command("operation:complete")
  .description("Mark an operation as completed")
  .argument("<id>", "Operation ID")
  .action(async (id, opts) => {
    const db = initDb(opts);
    try {
      const completed = completeOperation(id, db);
      await emitWebhook("operation.completed", { operation_id: completed.id, server_id: completed.server_id, agent_id: completed.agent_id, operation: completed }, db);
      console.log(chalk.green(`Completed: ${completed.id.slice(0, 8)}`));
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    closeDatabase();
  });

program
  .command("operation:fail")
  .description("Mark an operation as failed")
  .argument("<id>", "Operation ID")
  .option("--error <message>", "Error message")
  .action(async (id, opts) => {
    const db = initDb(opts);
    try {
      const failed = failOperation(id, opts.error || "Unknown error", db);
      await emitWebhook("operation.failed", { operation_id: failed.id, server_id: failed.server_id, agent_id: failed.agent_id, operation: failed }, db);
      console.log(chalk.red(`Failed: ${failed.id.slice(0, 8)} — ${failed.error_message}`));
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    closeDatabase();
  });

program
  .command("operation:cancel")
  .description("Cancel a pending or running operation")
  .argument("<id>", "Operation ID")
  .action(async (id, opts) => {
    const db = initDb(opts);
    try {
      const cancelled = cancelOperation(id, db);
      await emitWebhook("operation.cancelled", { operation_id: cancelled.id, server_id: cancelled.server_id, agent_id: cancelled.agent_id, operation: cancelled }, db);
      console.log(chalk.yellow(`Cancelled: ${cancelled.id.slice(0, 8)}`));
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    closeDatabase();
  });

// ── Traces ───────────────────────────────────────────────────────────────────

program
  .command("traces")
  .description("List audit trail entries")
  .option("-s, --server <id>", "Filter by server")
  .option("-a, --agent <id>", "Filter by agent")
  .option("-l, --limit <n>", "Limit results", "100")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = initDb(opts);
    let traces: any[];
    if (opts.agent) {
      traces = listTracesByAgent(opts.agent, parsePositiveIntegerOption(opts.limit, "--limit") ?? 100, db);
    } else {
      traces = listTraces(opts.server, undefined, parsePositiveIntegerOption(opts.limit, "--limit") ?? 100, db);
    }
    if (wantsJson(opts)) {
      printJson(traces);
    } else {
      const headers = ["ID", "EVENT", "SERVER", "AGENT", "CREATED"];
      const rows = traces.map(t => [
        t.id.slice(0, 8),
        t.event,
        t.server_id.slice(0, 8),
        t.agent_id || "-",
        t.created_at,
      ]);
      console.log(formatTable(headers, rows.length > 0 ? rows : [["(none)", "", "", "", ""]]));
    }
    closeDatabase();
  });

program
  .command("trace:add")
  .description("Create an audit trail entry")
  .requiredOption("--server <id>", "Server ID, partial ID, or slug")
  .requiredOption("--event <event>", "Event name")
  .option("--operation <id>", "Operation ID")
  .option("--agent <id>", "Agent ID")
  .option("--details <json>", "JSON details")
  .action(async (opts) => {
    const db = initDb(opts);
    let serverId = opts.server;
    if (serverId.length < 36) {
      const resolved = resolvePartialId(db, "servers", serverId);
      if (resolved) serverId = resolved;
    }
    let details: Record<string, unknown> = {};
    if (opts.details) {
      try { details = JSON.parse(opts.details); } catch {
        console.error(chalk.red("--details must be valid JSON"));
        process.exit(1);
      }
    }
    const trace = createTrace({
      server_id: serverId,
      operation_id: opts.operation,
      agent_id: opts.agent,
      event: opts.event,
      details,
    }, db);
    await emitWebhook("trace.created", { trace_id: trace.id, server_id: trace.server_id, agent_id: trace.agent_id, operation_id: trace.operation_id, trace }, db);
    console.log(chalk.green(`Trace created: ${trace.id.slice(0, 8)} (${trace.event})`));
    closeDatabase();
  });

// ── Projects ─────────────────────────────────────────────────────────────────

program
  .command("projects")
  .description("List projects")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = initDb(opts);
    const projects = listProjects(db);
    if (wantsJson(opts)) {
      printJson(projects);
    } else {
      const headers = ["ID", "NAME", "PATH", "DESCRIPTION"];
      const rows = projects.map(p => [
        p.id.slice(0, 8),
        chalk.bold(p.name),
        p.path,
        p.description || "-",
      ]);
      console.log(formatTable(headers, rows.length > 0 ? rows : [["(none)", "", "", ""]]));
    }
    closeDatabase();
  });

program
  .command("project:add")
  .description("Register a project")
  .requiredOption("-n, --name <name>", "Project name")
  .option("--path <path>", "Project path (default: current git root)")
  .option("--description <desc>", "Description")
  .action(async (opts) => {
    const db = initDb(opts);
    const gitRoot = findNearestGitRoot(process.cwd());
    const path = opts.path || gitRoot || process.cwd();
    // Check if project already exists at this path
    const existing = getProjectByPath(path, db);
    if (existing) {
      console.log(chalk.yellow(`Project already exists: ${existing.name} at ${existing.path}`));
      closeDatabase();
      return;
    }
    const project = createProject({ name: opts.name, path, description: opts.description }, db);
    await emitWebhook("project.created", { project_id: project.id, project }, db);
    console.log(chalk.green(`Created project: ${project.name} at ${project.path}`));
    closeDatabase();
  });

// ── Webhooks ─────────────────────────────────────────────────────────────────

program
  .command("webhooks")
  .description("List webhooks")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = initDb(opts);
    const webhooks = listWebhooks(db);
    if (wantsJson(opts)) {
      printJson(webhooks);
    } else {
      const headers = ["ID", "STATUS", "URL", "EVENTS"];
      const rows = webhooks.map(w => [
        w.id.slice(0, 8),
        w.active ? chalk.green("active") : chalk.red("inactive"),
        w.url.slice(0, 50),
        w.events.join(",") || "*",
      ]);
      console.log(formatTable(headers, rows.length > 0 ? rows : [["(none)", "", "", ""]]));
    }
    closeDatabase();
  });

program
  .command("webhook:add")
  .description("Register a webhook")
  .requiredOption("--url <url>", "Webhook URL (HTTPS required)")
  .option("--events <events>", "Comma-separated events")
  .option("--secret <secret>", "Signing secret")
  .option("--server <id>", "Server ID filter")
  .option("--project <id>", "Project ID filter")
  .action(async (opts) => {
    const db = initDb(opts);
    const webhook = createWebhook({
      url: opts.url,
      events: opts.events?.split(",").map((s: string) => s.trim()),
      secret: opts.secret,
      server_id: opts.server,
      project_id: opts.project,
    }, db);
    await emitWebhook("webhook.created", { webhook_id: webhook.id, webhook }, db);
    console.log(chalk.green(`Created webhook: ${webhook.id.slice(0, 8)}`));
    closeDatabase();
  });

program
  .command("webhook:delete")
  .description("Delete a webhook")
  .argument("<id>", "Webhook ID")
  .action(async (id, opts) => {
    const db = initDb(opts);
    const existing = getWebhook(id, db);
    const deleted = deleteWebhook(id, db);
    if (deleted) {
      await emitWebhook("webhook.deleted", { webhook_id: id, webhook: existing }, db);
      console.log(chalk.green(`Deleted webhook: ${id.slice(0, 8)}`));
    } else {
      console.error(chalk.red(`Webhook not found: ${id}`));
      process.exit(1);
    }
    closeDatabase();
  });

program
  .command("webhook:toggle")
  .description("Activate or deactivate a webhook")
  .argument("<id>", "Webhook ID")
  .action(async (id, opts) => {
    const db = initDb(opts);
    const wh = getWebhook(id, db);
    if (!wh) {
      console.error(chalk.red(`Webhook not found: ${id}`));
      process.exit(1);
    }
    const newActive = !wh.active;
    db.run("UPDATE webhooks SET active = ? WHERE id = ?", [newActive ? 1 : 0, id]);
    await emitWebhook("webhook.toggled", { webhook_id: id, active: newActive }, db);
    console.log(chalk.green(`Webhook ${id.slice(0, 8)} → ${newActive ? "active" : "inactive"}`));
    closeDatabase();
  });

// ── Local lifecycle ──────────────────────────────────────────────────────────

program
  .command("servers:init")
  .alias("server:init")
  .description("Detect and register a local app server for the current project")
  .option("-n, --name <name>", "Server name (default: current folder)")
  .option("--path <path>", "Project path (default: current git root or cwd)")
  .option("--project-name <name>", "Project registry name")
  .option("--description <desc>", "Server description")
  .option("--command <cmd>", "Explicit start command instead of auto-detection")
  .option("--port <port>", "Expected local port")
  .option("--health-url <url>", "Readiness URL")
  .option("--env <pair>", "Environment variable KEY=VALUE", collectValue, [])
  .option("--log-file <path>", "Log file path")
  .option("--force", "Update an existing server with the same slug")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const db = initDb(opts);
    const gitRoot = findNearestGitRoot(process.cwd());
    const projectPath = resolve(opts.path || gitRoot || process.cwd());
    const name = opts.name || displayNameForServerConfig(projectPath);
    const projectName = opts.projectName || name;
    const port = parsePortOption(opts.port, "--port");
    const env = parseEnvOptions(opts.env);
    const detected = opts.command
      ? {
        command: opts.command as string,
        cwd: projectPath,
        port,
        healthUrl: opts.healthUrl || defaultLifecycleHealthUrl(port),
        metadata: { detected_from: "explicit" },
      }
      : detectProjectServerConfig(projectPath, { port, healthUrl: opts.healthUrl });

    let project = getProjectByPath(projectPath, db);
    if (!project) {
      project = createProject({ name: projectName, path: projectPath, description: opts.description }, db);
      await emitWebhook("project.created", { project_id: project.id, project }, db);
    }

    const metadata: Record<string, unknown> = {
      ...detected.metadata,
      start_command: detected.command,
      cwd: detected.cwd,
      port: detected.port,
      health_url: detected.healthUrl,
    };
    if (env) metadata.env = env;
    if (opts.logFile) metadata.log_file = resolve(opts.logFile);

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
    const existing = getServerBySlug(slug, db);
    let server: Server;
    if (existing) {
      if (!opts.force) {
        console.error(chalk.red(`Server already exists: ${existing.slug}. Use --force to update it.`));
        process.exit(1);
      }
      server = updateServer(existing.id, {
        name,
        path: projectPath,
        description: opts.description ?? existing.description,
        project_id: project.id,
        metadata: { ...existing.metadata, ...metadata },
      }, db);
      await emitWebhook("server.updated", { server_id: server.id, project_id: server.project_id, server }, db);
    } else {
      server = createServer({
        name,
        slug,
        path: projectPath,
        description: opts.description,
        status: "offline",
        project_id: project.id,
        metadata,
      }, db);
      await emitWebhook("server.created", { server_id: server.id, project_id: server.project_id, server }, db);
    }

    const output = { project, server: serverWithComputedFields(server), command: detected.command, next: `servers servers:start ${server.slug} --agent <name> --reason <why>` };
    if (wantsJson(opts)) {
      printJson(output);
    } else {
      console.log(chalk.green(`${existing ? "Updated" : "Registered"} server: ${server.name} (${server.slug})`));
      console.log(`  Project:    ${project.path}`);
      console.log(`  Command:    ${detected.command}`);
      console.log(`  CWD:        ${detected.cwd}`);
      console.log(`  Health:     ${detected.healthUrl || "-"}`);
      console.log(`  Next:       ${output.next}`);
    }
    closeDatabase();
  });

function defaultLifecycleHealthUrl(port: number | undefined): string | undefined {
  return port ? `http://127.0.0.1:${port}` : undefined;
}

program
  .command("servers:start")
  .alias("server:start")
  .description("Safely start a configured local app server and wait for readiness")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--agent <id>", "Agent ID/name requesting the lifecycle lock")
  .option("--session <id>", "Session ID")
  .option("--reason <text>", "Why the server is being started")
  .option("--command <cmd>", "Override configured start command")
  .option("--cwd <path>", "Override working directory")
  .option("--port <port>", "Expected local port")
  .option("--health-url <url>", "Readiness URL")
  .option("--env <pair>", "Environment variable KEY=VALUE", collectValue, [])
  .option("--log-file <path>", "Log file path")
  .option("--timeout <ms>", "Readiness timeout in ms")
  .option("--lock-timeout <ms>", "How long to wait for another lifecycle lock")
  .option("--wait-lock", "Wait for another agent's lifecycle lock")
  .option("--no-wait", "Do not wait for readiness")
  .option("--force", "Start even if the configured health check is already ready")
  .option("--json", "Output as JSON")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    try {
      const result = await startLocalServer(idOrSlug, lifecycleOptions(opts), db);
      await emitWebhook("server.started", { server_id: result.server.id, project_id: result.server.project_id, operation_id: result.operation.id, agent_id: opts.agent, server: result.server, operation: result.operation, snapshot: result.snapshot }, db);
      if (wantsJson(opts)) {
        printJson({ ...result, server: serverWithComputedFields(result.server) });
      } else {
        console.log(chalk.green(`Started: ${result.server.name} (${result.server.slug})`));
        console.log(`  PID:        ${result.pid || result.snapshot.pid || "-"}`);
        console.log(`  Ready:      ${result.ready ? "yes" : "not yet"}`);
        console.log(`  Health:     ${result.snapshot.healthUrl || "-"}`);
        console.log(`  Logs:       ${result.snapshot.logFile || "-"}`);
        console.log(`  Operation:  ${result.operation.id.slice(0, 8)}`);
      }
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    } finally {
      closeDatabase();
    }
  });

program
  .command("servers:restart")
  .alias("server:restart")
  .description("Safely restart a configured local app server with a lifecycle lock")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--agent <id>", "Agent ID/name requesting the lifecycle lock")
  .option("--session <id>", "Session ID")
  .option("--reason <text>", "Why the server is being restarted")
  .option("--command <cmd>", "Override configured start command")
  .option("--cwd <path>", "Override working directory")
  .option("--port <port>", "Expected local port")
  .option("--health-url <url>", "Readiness URL")
  .option("--env <pair>", "Environment variable KEY=VALUE", collectValue, [])
  .option("--log-file <path>", "Log file path")
  .option("--timeout <ms>", "Readiness timeout in ms")
  .option("--stop-timeout <ms>", "Stop timeout in ms")
  .option("--lock-timeout <ms>", "How long to wait for another lifecycle lock")
  .option("--wait-lock", "Wait for another agent's lifecycle lock")
  .option("--no-wait", "Do not wait for readiness")
  .option("--force", "Send SIGKILL if graceful stop times out")
  .option("--json", "Output as JSON")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    try {
      const result = await restartLocalServer(idOrSlug, lifecycleOptions(opts), db);
      await emitWebhook("server.restarted", { server_id: result.server.id, project_id: result.server.project_id, operation_id: result.operation.id, agent_id: opts.agent, server: result.server, operation: result.operation, snapshot: result.snapshot }, db);
      if (wantsJson(opts)) {
        printJson({ ...result, server: serverWithComputedFields(result.server) });
      } else {
        console.log(chalk.green(`Restarted: ${result.server.name} (${result.server.slug})`));
        console.log(`  PID:        ${result.pid || result.snapshot.pid || "-"}`);
        console.log(`  Ready:      ${result.ready ? "yes" : "not yet"}`);
        console.log(`  Health:     ${result.snapshot.healthUrl || "-"}`);
        console.log(`  Logs:       ${result.snapshot.logFile || "-"}`);
        console.log(`  Operation:  ${result.operation.id.slice(0, 8)}`);
      }
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    } finally {
      closeDatabase();
    }
  });

program
  .command("servers:stop")
  .alias("server:stop")
  .description("Safely stop a configured local app server")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--agent <id>", "Agent ID/name requesting the lifecycle lock")
  .option("--session <id>", "Session ID")
  .option("--reason <text>", "Why the server is being stopped")
  .option("--timeout <ms>", "Stop timeout in ms")
  .option("--stop-timeout <ms>", "Stop timeout in ms")
  .option("--lock-timeout <ms>", "How long to wait for another lifecycle lock")
  .option("--wait-lock", "Wait for another agent's lifecycle lock")
  .option("--no-wait", "Do not wait for process exit")
  .option("--force", "Send SIGKILL if graceful stop times out")
  .option("--json", "Output as JSON")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    try {
      const result = await stopLocalServer(idOrSlug, lifecycleOptions(opts), db);
      await emitWebhook("server.stopped", { server_id: result.server.id, project_id: result.server.project_id, operation_id: result.operation.id, agent_id: opts.agent, server: result.server, operation: result.operation, snapshot: result.snapshot }, db);
      if (wantsJson(opts)) {
        printJson({ ...result, server: serverWithComputedFields(result.server) });
      } else {
        console.log(chalk.green(`Stopped: ${result.server.name} (${result.server.slug})`));
        console.log(`  Operation:  ${result.operation.id.slice(0, 8)}`);
      }
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    } finally {
      closeDatabase();
    }
  });

program
  .command("servers:status")
  .alias("server:status")
  .description("Check local process/readiness status for a server")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--refresh", "Write observed status and heartbeat back to the registry")
  .option("--timeout <ms>", "Health-check timeout in ms")
  .option("--json", "Output as JSON")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    const server = resolveServerOrExit(idOrSlug, db);
    const snapshot = await getLocalServerSnapshot(server, { timeoutMs: parsePositiveIntegerOption(opts.timeout, "--timeout") });
    let updated = server;
    if (opts.refresh) {
      updated = updateServer(server.id, {
        status: snapshot.status,
        last_heartbeat: snapshot.ready ? now() : undefined,
      }, db);
      await emitWebhook("server.status", { server_id: updated.id, project_id: updated.project_id, server: updated, snapshot }, db);
    }
    if (wantsJson(opts)) {
      printJson({ server: serverWithComputedFields(updated), snapshot });
    } else {
      const color = snapshot.ready ? chalk.green : snapshot.running ? chalk.yellow : chalk.red;
      console.log(color(`${updated.name}: ${snapshot.status}`));
      console.log(`  PID:        ${snapshot.pid || "-"}`);
      console.log(`  Running:    ${snapshot.running ? "yes" : "no"}`);
      console.log(`  Ready:      ${snapshot.ready ? "yes" : "no"}`);
      console.log(`  Health:     ${snapshot.healthUrl || "-"}`);
      console.log(`  Logs:       ${snapshot.logFile || "-"}`);
    }
    closeDatabase();
  });

program
  .command("servers:wait")
  .alias("server:wait")
  .description("Wait until a server is online/ready or offline/stopped")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--state <state>", "Target state (online/offline)", "online")
  .option("--timeout <ms>", "Wait timeout in ms", "30000")
  .option("--json", "Output as JSON")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    const server = resolveServerOrExit(idOrSlug, db);
    const timeoutMs = parsePositiveIntegerOption(opts.timeout, "--timeout") ?? 30000;
    const target = opts.state === "offline" ? "offline" : "online";
    const deadline = Date.now() + timeoutMs;
    let snapshot = await getLocalServerSnapshot(server);
    while (Date.now() < deadline) {
      const reached = target === "online" ? snapshot.ready : !snapshot.running;
      if (reached) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
      snapshot = await getLocalServerSnapshot(getServer(server.id, db) || server);
    }
    const reached = target === "online" ? snapshot.ready : !snapshot.running;
    if (wantsJson(opts)) {
      printJson({ reached, target, snapshot });
    } else if (reached) {
      console.log(chalk.green(`Reached ${target}: ${server.name}`));
    } else {
      console.error(chalk.red(`Timed out waiting for ${target}: ${server.name}`));
    }
    closeDatabase();
    if (!reached) process.exit(1);
  });

program
  .command("servers:logs")
  .alias("server:logs")
  .description("Show the managed log file for a server")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("-n, --lines <n>", "Number of lines to show", "80")
  .action((idOrSlug, opts) => {
    const db = initDb(opts);
    const server = resolveServerOrExit(idOrSlug, db);
    const logFile = typeof server.metadata.log_file === "string" ? server.metadata.log_file : null;
    if (!logFile || !existsSync(logFile)) {
      console.error(chalk.red(`No log file found for ${server.name}`));
      process.exit(1);
    }
    const lines = readFileSync(logFile, "utf-8").split(/\r?\n/);
    const count = parsePositiveIntegerOption(opts.lines, "--lines") ?? 80;
    console.log(lines.slice(-count).join("\n"));
    closeDatabase();
  });

program
  .command("servers:debug")
  .alias("server:debug")
  .description("Show lifecycle config, lock, operations, traces, and readiness for a server")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--json", "Output as JSON")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    const server = resolveServerOrExit(idOrSlug, db);
    const snapshot = await getLocalServerSnapshot(server);
    const lock = db.query("SELECT * FROM resource_locks WHERE resource_type = ? AND resource_id = ?").get("server-runtime", server.id);
    const operations = listOperations(server.id, undefined, 10, db);
    const traces = listTraces(server.id, undefined, 10, db);
    const output = { server: serverWithComputedFields(server), snapshot, lock, operations, traces };
    if (wantsJson(opts)) {
      printJson(output);
    } else {
      console.log(chalk.bold(`Debug: ${server.name} (${server.slug})`));
      console.log(`  Status:     ${server.status}`);
      console.log(`  PID:        ${snapshot.pid || "-"}`);
      console.log(`  Running:    ${snapshot.running ? "yes" : "no"}`);
      console.log(`  Ready:      ${snapshot.ready ? "yes" : "no"}`);
      console.log(`  Command:    ${redactSensitiveFields(snapshot.command) || "-"}`);
      console.log(`  CWD:        ${snapshot.cwd || "-"}`);
      console.log(`  Health:     ${snapshot.healthUrl || "-"}`);
      console.log(`  Lock:       ${lock ? stringifyForDisplay(lock) : "-"}`);
      console.log(chalk.bold("\n  Recent operations"));
      for (const op of operations) console.log(`    ${op.id.slice(0, 8)} ${op.status.padEnd(10)} ${op.operation_type.padEnd(10)} ${redactSensitiveFields(op.metadata.reason || "")}`);
      if (operations.length === 0) console.log("    (none)");
      console.log(chalk.bold("\n  Recent traces"));
      for (const trace of traces) console.log(`    ${trace.id.slice(0, 8)} ${trace.event.padEnd(24)} ${trace.agent_id || "-"}`);
      if (traces.length === 0) console.log("    (none)");
    }
    closeDatabase();
  });

program
  .command("servers:heartbeat")
  .alias("server:heartbeat")
  .description("Send a heartbeat for a server")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    let server = getServer(idOrSlug, db);
    if (!server) server = getServerBySlug(idOrSlug, db);
    if (!server) {
      const resolved = resolvePartialId(db, "servers", idOrSlug);
      if (resolved) server = getServer(resolved, db);
    }
    if (!server) {
      console.error(chalk.red(`Server not found: ${idOrSlug}`));
      process.exit(1);
    }
    const updated = heartbeatServer(server.id, db);
    await emitWebhook("server.heartbeat", { server_id: updated.id, project_id: updated.project_id, server: updated }, db);
    console.log(chalk.green(`Heartbeat: ${updated.name} at ${updated.last_heartbeat}`));
    closeDatabase();
  });

// ── Agent: archive / release ─────────────────────────────────────────────────

program
  .command("agent:archive")
  .description("Archive an agent")
  .argument("<name>", "Agent name")
  .action(async (name, opts) => {
    const db = initDb(opts);
    const agent = getAgentByName(name, db);
    if (!agent) {
      console.error(chalk.red(`Agent not found: ${name}`));
      process.exit(1);
    }
    const ok = archiveAgent(agent.id, db);
    if (ok) {
      await emitWebhook("agent.archived", { agent_id: agent.id, agent }, db);
      console.log(chalk.green(`Archived agent: ${agent.name}`));
    } else {
      console.error(chalk.red(`Failed to archive agent: ${agent.name}`));
    }
    closeDatabase();
  });

program
  .command("agent:release")
  .description("Release an agent's locks")
  .argument("<name>", "Agent name")
  .action(async (name, opts) => {
    const db = initDb(opts);
    const agent = getAgentByName(name, db);
    if (!agent) {
      console.error(chalk.red(`Agent not found: ${name}`));
      process.exit(1);
    }
    const released = releaseAgent(agent.id, db);
    await emitWebhook("agent.released", { agent_id: released.id, agent: released }, db);
    console.log(chalk.green(`Released agent: ${released.name}`));
    closeDatabase();
  });

// ── Operation: update / delete ───────────────────────────────────────────────

program
  .command("operation:update")
  .description("Update an operation's status, error, or results")
  .argument("<id>", "Operation ID")
  .option("--status <status>", "New status (pending, running, completed, failed, cancelled)")
  .option("--error <message>", "Error message")
  .action(async (id, opts) => {
    const db = initDb(opts);
    const update: Record<string, string> = {};
    if (opts.status) update.status = opts.status;
    if (opts.error !== undefined) update.error_message = opts.error;
    if (Object.keys(update).length === 0) {
      console.error(chalk.yellow("No fields to update. Use --status, --error, etc."));
      process.exit(1);
    }
    try {
      const updated = updateOperation(id, update as any, db);
      await emitWebhook("operation.updated", { operation_id: updated.id, server_id: updated.server_id, agent_id: updated.agent_id, operation: updated, changes: update }, db);
      console.log(chalk.green(`Updated: ${updated.id.slice(0, 8)} → ${updated.status}`));
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    closeDatabase();
  });

program
  .command("operation:delete")
  .description("Delete an operation")
  .argument("<id>", "Operation ID")
  .action(async (id, opts) => {
    const db = initDb(opts);
    const existing = getOperation(id, db);
    try {
      const ok = deleteOperation(id, db);
      if (ok) {
        await emitWebhook("operation.deleted", { operation_id: id, operation: existing }, db);
        console.log(chalk.green(`Deleted operation: ${id.slice(0, 8)}`));
      }
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    closeDatabase();
  });

// ── Webhook: deliveries ──────────────────────────────────────────────────────

program
  .command("webhooks:logs")
  .alias("webhook:deliveries")
  .description("List webhook delivery logs")
  .option("--webhook <id>", "Filter by webhook")
  .option("-l, --limit <n>", "Limit results", "50")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = initDb(opts);
    const deliveries = listDeliveries(opts.webhook, parsePositiveIntegerOption(opts.limit, "--limit") ?? 50, db);
    if (wantsJson(opts)) {
      printJson(deliveries);
    } else {
      const headers = ["ID", "WEBHOOK", "STATUS", "ATTEMPT", "TIME"];
      const rows = deliveries.map(d => [
        d.id.slice(0, 8),
        d.webhook_id.slice(0, 8),
        d.status_code !== null && d.status_code < 400 ? chalk.green("ok") : chalk.red("fail"),
        d.attempt.toString(),
        d.created_at,
      ]);
      console.log(formatTable(headers, rows.length > 0 ? rows : [["(none)", "", "", "", ""]]));
    }
    closeDatabase();
  });

// ── Traces: delete ───────────────────────────────────────────────────────────

program
  .command("traces:delete")
  .description("Delete all traces for a server")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .action(async (idOrSlug, opts) => {
    const db = initDb(opts);
    let server = getServer(idOrSlug, db);
    if (!server) server = getServerBySlug(idOrSlug, db);
    if (!server) {
      const resolved = resolvePartialId(db, "servers", idOrSlug);
      if (resolved) server = getServer(resolved, db);
    }
    if (!server) {
      console.error(chalk.red(`Server not found: ${idOrSlug}`));
      process.exit(1);
    }
    const count = deleteTracesByServer(server.id, db);
    await emitWebhook("trace.deleted", { server_id: server.id, project_id: server.project_id, deleted_count: count, server }, db);
    console.log(chalk.green(`Deleted ${count} traces for server: ${server.name}`));
    closeDatabase();
  });

// ── Monitor / watch ──────────────────────────────────────────────────────────

program
  .command("monitor")
  .description("Watch server status with auto-refresh")
  .option("-i, --interval <ms>", "Refresh interval in ms", "5000")
  .action((opts) => {
    const interval = parsePositiveIntegerOption(opts.interval, "--interval") ?? 5000;
    const tick = () => {
      try {
        closeDatabase();
      } catch {}
      const db = initDb(opts);
      const servers = listServers(undefined, db);
      const agents = listAgents("active", db);
      const pendingOps = listOperations(undefined, "pending", 10, db);
      const runningOps = listOperations(undefined, "running", 10, db);

      process.stdout.write("\x1b[H\x1b[J"); // clear screen
      console.log(chalk.bold(`  Server Monitor — ${new Date().toISOString()} (refreshing every ${interval}ms)`));
      console.log(chalk.bold("\n  Servers"));
      for (const s of servers) {
        const color = s.status === "online" ? chalk.green : s.status === "offline" ? chalk.red : chalk.yellow;
        const url = getTailscaleUrl(s);
        console.log(`    ${color(s.status.padEnd(11))} ${s.name.padEnd(20)} ${s.hostname || "-"}${url ? `  ${url}` : ""}`);
      }
      if (servers.length === 0) console.log("    (no servers)");

      console.log(chalk.bold(`\n  Active Agents (${agents.length})`));
      for (const a of agents) {
        console.log(`    ${chalk.bold(a.name.padEnd(20))} session: ${a.session_id || "-"}`);
      }

      if (pendingOps.length > 0) {
        console.log(chalk.bold(`\n  Pending Operations (${pendingOps.length})`));
        for (const o of pendingOps) {
          console.log(`    ${chalk.yellow("pending".padEnd(9))} ${o.operation_type.padEnd(14)} server:${o.server_id.slice(0, 8)}`);
        }
      }
      if (runningOps.length > 0) {
        console.log(chalk.bold(`\n  Running Operations (${runningOps.length})`));
        for (const o of runningOps) {
          console.log(`    ${chalk.blue("running".padEnd(9))} ${o.operation_type.padEnd(14)} server:${o.server_id.slice(0, 8)}`);
        }
      }
      console.log("");
    };
    tick();
    setInterval(tick, interval);
  });

// ── Export / Import ──────────────────────────────────────────────────────────

program
  .command("export")
  .description("Export the entire database as JSON")
  .option("--output <path>", "Output file path")
  .action(async (opts) => {
    const { writeFileSync } = await import("fs");
    const db = initDb(opts);
    const data = {
      servers: listServers(undefined, db),
      agents: listAgents(undefined, db),
      operations: listOperations(undefined, undefined, 10000, db),
      traces: listTraces(undefined, undefined, 10000, db),
      projects: listProjects(db),
      webhooks: listWebhooks(db),
    };
    const json = JSON.stringify(data, null, 2);
    if (opts.output) {
      writeFileSync(opts.output, json);
      console.log(chalk.green(`Exported to ${opts.output} (${(json.length / 1024).toFixed(1)} KB)`));
    } else {
      console.log(json);
    }
    closeDatabase();
  });

program
  .command("import")
  .description("Import data from a JSON export file")
  .requiredOption("--input <path>", "Input JSON file path")
  .action(async (opts) => {
    const { readFileSync } = await import("fs");
    let data: Record<string, unknown[]>;
    try {
      data = JSON.parse(readFileSync(opts.input, "utf-8"));
    } catch {
      console.error(chalk.red(`Failed to read ${opts.input}`));
      process.exit(1);
    }
    const db = initDb(opts);
    let counts: Record<string, number> = {};
    // Map exported keys to actual table names
    const tableMap: Record<string, string> = {
      servers: "servers",
      agents: "agents",
      operations: "server_operations",
      traces: "traces",
      projects: "projects",
      webhooks: "webhooks",
    };
    for (const [key, rows] of Object.entries(data) as [string, unknown[]][]) {
      if (!Array.isArray(rows)) continue;
      const table = tableMap[key] || key;
      counts[key] = rows.length;
      for (const row of rows as Record<string, unknown>[]) {
        const cols = Object.keys(row).filter(k => k !== "id");
        const placeholders = cols.map(() => "?").join(", ");
        const vals = cols.map(k => {
          const v = row[k];
          if (v === null || v === undefined) return null;
          if (Array.isArray(v)) return JSON.stringify(v);
          if (typeof v === "object") return JSON.stringify(v);
          return v;
        });
        db.run(`INSERT OR REPLACE INTO ${table} (id, ${cols.join(", ")}) VALUES (?, ${placeholders})`, [row.id as string, ...vals] as any[]);
      }
    }
    console.log(chalk.green("Imported:"));
    for (const [table, count] of Object.entries(counts)) {
      console.log(`  ${table}: ${count} rows`);
    }
    closeDatabase();
  });

program
  .command("completion")
  .description("Generate shell completion script")
  .argument("<shell>", "Shell type (bash, zsh, fish)")
  .action((shell) => {
    const commands = program.commands;
    const globalOptions = ["--db", "--format", "--help", "--version"];

    function getAllCommands(): { name: string; desc: string; options: string[] }[] {
      return commands.flatMap(c => {
        const desc = c.description() || "";
        const options = c.options.map(o => o.long || o.short || "");
        return [c.name(), ...c.aliases()].map(name => ({ name, desc, options }));
      });
    }

    if (shell === "bash") {
      const all = getAllCommands();
      const names = all.map(c => c.name).join(" ");
      const optsLines = all.map(c => {
        const opts = [...globalOptions, ...c.options].join(" ");
        return `      "${c.name}") COMPREPLY=($(compgen -W "${opts}" -- "$cur")) ;;`;
      }).join("\n");
      const script = `_servers_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local cmds="${names}"
  COMPREPLY=()

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$cmds ${globalOptions.join(" ")}" -- "$cur"))
    return
  fi

  case "\${COMP_WORDS[1]}" in
${optsLines}
  esac
};

complete -F _servers_completions servers`;
      console.log(script);
    } else if (shell === "zsh") {
      const all = getAllCommands();
      const cmdList = all.map(c => `      '${c.name}:${c.desc}'`).join("\\\n");
      const cmdNames = all.map(c => c.name).join(" ");
      let script = `#compdef servers

_servers() {
  local -a commands
  commands=(
${cmdList}
  )

  _arguments \\
    '1: :->command' \\
    '*: :->arg' \\
    '--db[Path to SQLite database]' \\
    '--format[Output format (table, json)]' \\
    '--help[Show help]' \\
    '--version[Show version]' && return 0

  case $state in
    command)
      _describe -t commands 'servers commands' commands
      ;;
  esac
}

compdef _servers servers`;
      console.log(script);
    } else if (shell === "fish") {
      const all = getAllCommands();
      const cmdDescs = all.map(c => `complete -c servers -n "__fish_use_subcommand" -a "${c.name}" -d "${c.desc}"`).join("\n");
      let script = `# fish completions for servers

# Global options
complete -c servers -s h -l help -d "Show help"
complete -c servers -l version -d "Show version"
complete -c servers -l db -d "Path to SQLite database"
complete -c servers -l format -d "Output format (table, json)"

# Commands
${cmdDescs}
`;
      console.log(script);
    } else {
      console.error(chalk.red(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`));
      process.exit(1);
    }
  });

program
  .command("dashboard")
  .description("Interactive TUI dashboard")
  .action(async () => {
    const { startDashboard } = await import("../tui/dashboard.js");
    await startDashboard();
  });

program.parseAsync();
