#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { getDatabase, closeDatabase } from "../db/database.js";
import { listServers, getServer, getServerBySlug, createServer } from "../db/servers.js";
import { listAgents, registerAgent } from "../db/agents.js";
import { listOperations } from "../db/operations.js";
import { listTraces } from "../db/traces.js";
import { listProjects, createProject } from "../db/projects.js";
import { listWebhooks, createWebhook } from "../db/webhooks.js";
import { ensureSchema } from "../db/schema.js";

function getVersion(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dir, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch { return "0.0.0"; }
}

const program = new Command();

program
  .name("servers")
  .description("Server management for AI coding agents")
  .version(getVersion());

// ── servers ────────────────────────────────────────────────────────────────

program
  .command("server")
  .description("List registered servers")
  .option("-p, --project <id>", "Filter by project")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = getDatabase();
    ensureSchema(db);
    const servers = listServers(opts.project);
    if (opts.json) {
      console.log(JSON.stringify(servers, null, 2));
    } else {
      console.log(chalk.bold("Servers:"));
      for (const s of servers) {
        const statusColor = s.status === "online" ? chalk.green : s.status === "offline" ? chalk.red : chalk.yellow;
        console.log(`  ${s.id.slice(0, 8)}  ${statusColor(s.status.padEnd(12))} ${chalk.bold(s.name.padEnd(20))} ${s.slug}  ${s.hostname || "-"}`);
      }
      if (servers.length === 0) console.log("  (none)");
    }
    closeDatabase();
  });

program
  .command("server:get")
  .description("Get server details")
  .argument("<id-or-slug>", "Server ID or slug")
  .option("--json", "Output as JSON")
  .action((idOrSlug, opts) => {
    const db = getDatabase();
    ensureSchema(db);
    let server = getServer(idOrSlug);
    if (!server) server = getServerBySlug(idOrSlug);
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
  .command("server:add")
  .description("Register a new server")
  .requiredOption("-n, --name <name>", "Server name")
  .option("--slug <slug>", "URL-friendly slug")
  .option("--hostname <hostname>", "Hostname or IP")
  .option("--path <path>", "SSH or local path")
  .option("--description <desc>", "Description")
  .option("--status <status>", "Initial status")
  .option("--project <id>", "Project ID")
  .action((opts) => {
    const db = getDatabase();
    ensureSchema(db);
    const server = createServer({
      name: opts.name,
      slug: opts.slug,
      hostname: opts.hostname,
      path: opts.path,
      description: opts.description,
      status: opts.status,
      project_id: opts.project,
    });
    console.log(chalk.green(`Created server: ${server.name} (${server.slug}, id: ${server.id.slice(0, 8)})`));
    closeDatabase();
  });

// ── agents ─────────────────────────────────────────────────────────────────

program
  .command("agents")
  .description("List registered agents")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = getDatabase();
    ensureSchema(db);
    const agents = listAgents();
    if (opts.json) {
      console.log(JSON.stringify(agents, null, 2));
    } else {
      console.log(chalk.bold("Agents:"));
      for (const a of agents) {
        console.log(`  ${a.id.slice(0, 8)}  ${a.status.padEnd(10)} ${chalk.bold(a.name.padEnd(20))} session: ${a.session_id || "-"}  last: ${a.last_seen_at}`);
      }
      if (agents.length === 0) console.log("  (none)");
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
  .option("--working-dir <dir>", "Working directory")
  .action((opts) => {
    const db = getDatabase();
    ensureSchema(db);
    const agent = registerAgent({
      name: opts.name,
      description: opts.description,
      capabilities: opts.capabilities?.split(",").map((s: string) => s.trim()),
      session_id: opts.session,
      working_dir: opts.workingDir,
    });
    console.log(chalk.green(`Registered: ${agent.name} (${agent.id.slice(0, 8)})`));
    closeDatabase();
  });

// ── operations ─────────────────────────────────────────────────────────────

program
  .command("operations")
  .description("List server operations")
  .option("-s, --server <id>", "Filter by server")
  .option("--status <status>", "Filter by status")
  .option("-l, --limit <n>", "Limit results", "50")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = getDatabase();
    ensureSchema(db);
    const ops = listOperations(opts.server, opts.status, parseInt(opts.limit));
    if (opts.json) {
      console.log(JSON.stringify(ops, null, 2));
    } else {
      console.log(chalk.bold("Operations:"));
      for (const o of ops) {
        console.log(`  ${o.id.slice(0, 8)}  ${o.status.padEnd(11)} ${o.operation_type.padEnd(14)} server:${o.server_id.slice(0, 8)}  ${o.started_at}`);
      }
      if (ops.length === 0) console.log("  (none)");
    }
    closeDatabase();
  });

// ── traces ─────────────────────────────────────────────────────────────────

program
  .command("traces")
  .description("List audit trail entries")
  .option("-s, --server <id>", "Filter by server")
  .option("-l, --limit <n>", "Limit results", "100")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = getDatabase();
    ensureSchema(db);
    const traces = listTraces(opts.server, undefined, parseInt(opts.limit));
    if (opts.json) {
      console.log(JSON.stringify(traces, null, 2));
    } else {
      console.log(chalk.bold("Traces:"));
      for (const t of traces) {
        console.log(`  ${t.id.slice(0, 8)}  ${t.event.padEnd(30)} server:${t.server_id.slice(0, 8)}  ${t.agent_id || "-"}  ${t.created_at}`);
      }
      if (traces.length === 0) console.log("  (none)");
    }
    closeDatabase();
  });

// ── projects ───────────────────────────────────────────────────────────────

program
  .command("projects")
  .description("List projects")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = getDatabase();
    ensureSchema(db);
    const projects = listProjects();
    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
    } else {
      console.log(chalk.bold("Projects:"));
      for (const p of projects) {
        console.log(`  ${p.id.slice(0, 8)}  ${chalk.bold(p.name.padEnd(20))} ${p.path}`);
      }
      if (projects.length === 0) console.log("  (none)");
    }
    closeDatabase();
  });

program
  .command("project:add")
  .description("Register a project")
  .requiredOption("-n, --name <name>", "Project name")
  .requiredOption("--path <path>", "Project path")
  .option("--description <desc>", "Description")
  .action((opts) => {
    const db = getDatabase();
    ensureSchema(db);
    const project = createProject({ name: opts.name, path: opts.path, description: opts.description });
    console.log(chalk.green(`Created project: ${project.name} (${project.id.slice(0, 8)})`));
    closeDatabase();
  });

// ── webhooks ───────────────────────────────────────────────────────────────

program
  .command("webhooks")
  .description("List webhooks")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = getDatabase();
    ensureSchema(db);
    const webhooks = listWebhooks();
    if (opts.json) {
      console.log(JSON.stringify(webhooks, null, 2));
    } else {
      console.log(chalk.bold("Webhooks:"));
      for (const w of webhooks) {
        const active = w.active ? chalk.green("active") : chalk.red("inactive");
        console.log(`  ${w.id.slice(0, 8)}  ${active.padEnd(10)} ${w.url}  events: ${w.events.join(",") || "*"}`);
      }
      if (webhooks.length === 0) console.log("  (none)");
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
    const db = getDatabase();
    ensureSchema(db);
    const webhook = createWebhook({
      url: opts.url,
      events: opts.events?.split(",").map((s: string) => s.trim()),
      secret: opts.secret,
      server_id: opts.server,
      project_id: opts.project,
    });
    console.log(chalk.green(`Created webhook: ${webhook.id.slice(0, 8)}`));
    closeDatabase();
  });

program.parse();
