import { Database } from "bun:sqlite";
import { applyMigrations } from "./migrations.js";

export function runMigrations(db: Database): void {
  applyMigrations(db);
  ensureSchema(db);
}

function ensureTable(name: string, sql: string, db: Database): void {
  try {
    const exists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!exists) db.exec(sql);
  } catch {}
}

function ensureIndex(sql: string, db: Database): void {
  try { db.exec(sql); } catch {}
}

export function ensureSchema(db: Database): void {
  // ── Indexes ───────────────────────────────────────────────────────────
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_servers_project ON servers(project_id)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_servers_slug ON servers(slug)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_servers_locked ON servers(locked_by) WHERE locked_by IS NOT NULL", db);

  ensureIndex("CREATE INDEX IF NOT EXISTS idx_operations_server ON server_operations(server_id)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_operations_status ON server_operations(status)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_operations_agent ON server_operations(agent_id)", db);

  ensureIndex("CREATE INDEX IF NOT EXISTS idx_traces_server ON traces(server_id)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_traces_operation ON traces(operation_id)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_traces_event ON traces(event)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_id)", db);

  ensureIndex("CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id) WHERE session_id IS NOT NULL", db);

  ensureIndex("CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_agent_sessions_session ON agent_sessions(session_id)", db);

  ensureIndex("CREATE INDEX IF NOT EXISTS idx_resource_locks_agent ON resource_locks(agent_id)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_resource_locks_expires ON resource_locks(expires_at)", db);

  ensureIndex("CREATE INDEX IF NOT EXISTS idx_webhooks_project ON webhooks(project_id)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_webhooks_server ON webhooks(server_id)", db);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id)", db);
}
