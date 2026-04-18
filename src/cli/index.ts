#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import chalk from "chalk";
import {
  getDatabase,
  closeDatabase,
  resolvePartialId,
  LOCK_EXPIRY_MINUTES,
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
} from "../db/servers.js";
import {
  listAgents,
  registerAgent,
  getAgentByName,
  updateAgent,
  heartbeatAgent,
} from "../db/agents.js";
import {
  listOperations,
  createOperation,
  startOperation,
  completeOperation,
  failOperation,
  cancelOperation,
} from "../db/operations.js";
import {
  listTraces,
  listTracesByAgent,
  createTrace,
} from "../db/traces.js";
import {
  listProjects,
  createProject,
  getProjectByPath,
} from "../db/projects.js";
import {
  listWebhooks,
  createWebhook,
  getWebhook,
  deleteWebhook,
} from "../db/webhooks.js";

function getVersion(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dir, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch { return "0.0.0"; }
}

function initDb(opts?: { dbPath?: string }) {
  if (opts?.dbPath) process.env["SERVERS_DB_PATH"] = opts.dbPath;
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

function formatTable(headers: string[], rows: string[][]): string {
  const cols = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]?.length ?? 0)));
  const pad = cols.map(c => c + 2);
  const header = headers.map((h, i) => h.padEnd(pad[i])).join("").trimEnd();
  const separator = cols.map(c => "─".repeat(c + 2)).join("").trimEnd();
  const body = rows.map(r => r.map((cell, i) => cell.padEnd(pad[i])).join("").trimEnd()).join("\n");
  return `${header}\n${separator}\n${body}`;
}

// ── Program ──────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("servers")
  .description("Server management for AI coding agents")
  .version(getVersion())
  .option("--db <path>", "Path to SQLite database");

// ── Dashboard (default) ──────────────────────────────────────────────────────

program
  .action((opts) => {
    const db = initDb(opts);
    const servers = listServers(undefined, db);
    const agents = listAgents("active", db);
    const ops = listOperations(undefined, undefined, 10, db);
    const traces = listTraces(undefined, undefined, 5, db);

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
  .command("server")
  .description("List registered servers")
  .option("-p, --project <id>", "Filter by project")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = initDb(opts);
    const servers = listServers(opts.project, db);
    if (opts.json) {
      console.log(JSON.stringify(servers, null, 2));
    } else {
      const headers = ["ID", "STATUS", "NAME", "SLUG", "HOSTNAME"];
      const rows = servers.map(s => [
        s.id.slice(0, 8),
        s.status === "online" ? chalk.green(s.status) : s.status === "offline" ? chalk.red(s.status) : chalk.yellow(s.status),
        chalk.bold(s.name),
        s.slug,
        s.hostname || "-",
      ]);
      console.log(formatTable(headers, rows.length > 0 ? rows : [["(none)", "", "", "", ""]]));
    }
    closeDatabase();
  });

program
  .command("server:add")
  .description("Register a new server")
  .requiredOption("-n, --name <name>", "Server name")
  .option("--slug <slug>", "URL-friendly slug")
  .option("--hostname <hostname>", "Hostname or IP")
  .option("--path <path>", "SSH or local path")
  .option("--description <desc>", "Description")
  .option("--status <status>", "Initial status (default: unknown)")
  .option("--project <id>", "Project ID")
  .action((opts) => {
    const db = initDb(opts);
    const server = createServer({
      name: opts.name,
      slug: opts.slug,
      hostname: opts.hostname,
      path: opts.path,
      description: opts.description,
      status: opts.status,
      project_id: opts.project,
    }, db);
    console.log(chalk.green(`Created server: ${server.name} (${server.slug}, id: ${server.id.slice(0, 8)})`));
    closeDatabase();
  });

program
  .command("server:update")
  .description("Update a server")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--name <name>", "New name")
  .option("--slug <slug>", "New slug")
  .option("--hostname <hostname>", "Hostname or IP")
  .option("--path <path>", "SSH or local path")
  .option("--description <desc>", "Description")
  .option("--status <status>", "New status")
  .option("--project <id>", "Project ID")
  .action((idOrSlug, opts) => {
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
    const update: Record<string, string> = {};
    if (opts.name !== undefined) update.name = opts.name;
    if (opts.slug !== undefined) update.slug = opts.slug;
    if (opts.hostname !== undefined) update.hostname = opts.hostname;
    if (opts.path !== undefined) update.path = opts.path;
    if (opts.description !== undefined) update.description = opts.description;
    if (opts.status !== undefined) update.status = opts.status;
    if (opts.project !== undefined) update.project_id = opts.project;
    if (Object.keys(update).length === 0) {
      console.error(chalk.yellow("No fields to update. Use --name, --status, etc."));
      process.exit(1);
    }
    const updated = updateServer(server.id, update as any, db);
    console.log(chalk.green(`Updated server: ${updated.name}`));
    closeDatabase();
  });

program
  .command("server:get")
  .description("Get server details")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .option("--json", "Output as JSON")
  .action((idOrSlug, opts) => {
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
    if (opts.json) {
      console.log(JSON.stringify(server, null, 2));
    } else {
      console.log(chalk.bold("Server:"));
      console.log(`  ID:          ${server.id}`);
      console.log(`  Name:        ${server.name}`);
      console.log(`  Slug:        ${server.slug}`);
      console.log(`  Status:      ${server.status}`);
      console.log(`  Hostname:    ${server.hostname || "-"}`);
      console.log(`  Path:        ${server.path || "-"}`);
      console.log(`  Project:     ${server.project_id || "-"}`);
      console.log(`  Locked by:   ${server.locked_by || "-"}`);
      console.log(`  Heartbeat:   ${server.last_heartbeat || "-"}`);
      console.log(`  Description: ${server.description || "-"}`);
    }
    closeDatabase();
  });

program
  .command("server:delete")
  .description("Delete a server (must not be locked)")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .action((idOrSlug, opts) => {
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
    console.log(chalk.green(`Deleted server: ${server.name}`));
    closeDatabase();
  });

program
  .command("server:lock")
  .description("Lock a server (prevent modifications)")
  .requiredOption("--agent <id>", "Agent ID requesting lock")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .action((idOrSlug, opts) => {
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
      console.log(chalk.green(`Locked server: ${locked.name} by ${locked.locked_by}`));
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    closeDatabase();
  });

program
  .command("server:unlock")
  .description("Unlock a server")
  .requiredOption("--agent <id>", "Agent ID that holds the lock")
  .argument("<id-or-slug>", "Server ID, partial ID, or slug")
  .action((idOrSlug, opts) => {
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
    if (opts.json) {
      console.log(JSON.stringify(agents, null, 2));
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
  .action((opts) => {
    const db = initDb(opts);
    const workingDir = opts.workingDir || process.cwd();
    const agent = registerAgent({
      name: opts.name,
      description: opts.description,
      capabilities: opts.capabilities?.split(",").map((s: string) => s.trim()),
      session_id: opts.session,
      working_dir: workingDir,
    }, db);
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
  .action((name, opts) => {
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
    console.log(chalk.green(`Updated agent: ${updated.name}`));
    closeDatabase();
  });

program
  .command("agent:heartbeat")
  .description("Send a heartbeat for an agent")
  .argument("<name>", "Agent name or ID")
  .action((name, opts) => {
    const db = initDb(opts);
    const agent = getAgentByName(name, db);
    if (!agent) {
      console.error(chalk.red(`Agent not found: ${name}`));
      process.exit(1);
    }
    const updated = heartbeatAgent(agent.id, db);
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
    const ops = listOperations(serverId, opts.status, parseInt(opts.limit), db);
    if (opts.json) {
      console.log(JSON.stringify(ops, null, 2));
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
  .action((opts) => {
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
    console.log(chalk.green(`Created operation: ${op.id.slice(0, 8)} (${op.operation_type}) on server ${serverId.slice(0, 8)}`));
    closeDatabase();
  });

program
  .command("operation:start")
  .description("Start a pending operation")
  .argument("<id>", "Operation ID")
  .action((id, opts) => {
    const db = initDb(opts);
    try {
      const started = startOperation(id, db);
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
  .action((id, opts) => {
    const db = initDb(opts);
    try {
      const completed = completeOperation(id, db);
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
  .action((id, opts) => {
    const db = initDb(opts);
    try {
      const failed = failOperation(id, opts.error || "Unknown error", db);
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
  .action((id, opts) => {
    const db = initDb(opts);
    try {
      const cancelled = cancelOperation(id, db);
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
      traces = listTracesByAgent(opts.agent, parseInt(opts.limit), db);
    } else {
      traces = listTraces(opts.server, undefined, parseInt(opts.limit), db);
    }
    if (opts.json) {
      console.log(JSON.stringify(traces, null, 2));
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
  .action((opts) => {
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
    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
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
  .action((opts) => {
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
    if (opts.json) {
      console.log(JSON.stringify(webhooks, null, 2));
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
  .action((opts) => {
    const db = initDb(opts);
    const webhook = createWebhook({
      url: opts.url,
      events: opts.events?.split(",").map((s: string) => s.trim()),
      secret: opts.secret,
      server_id: opts.server,
      project_id: opts.project,
    }, db);
    console.log(chalk.green(`Created webhook: ${webhook.id.slice(0, 8)}`));
    closeDatabase();
  });

program
  .command("webhook:delete")
  .description("Delete a webhook")
  .argument("<id>", "Webhook ID")
  .action((id, opts) => {
    const db = initDb(opts);
    const deleted = deleteWebhook(id, db);
    if (deleted) {
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
  .action((id, opts) => {
    const db = initDb(opts);
    const wh = getWebhook(id, db);
    if (!wh) {
      console.error(chalk.red(`Webhook not found: ${id}`));
      process.exit(1);
    }
    const newActive = !wh.active;
    db.run("UPDATE webhooks SET active = ? WHERE id = ?", [newActive ? 1 : 0, id]);
    console.log(chalk.green(`Webhook ${id.slice(0, 8)} → ${newActive ? "active" : "inactive"}`));
    closeDatabase();
  });

program.parse();
