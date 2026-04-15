import type { Database } from "bun:sqlite";

/** Record which migration level we're at so upgrades can skip already-run steps. */
function recordMigration(db: Database, id: number): void {
  db.run("INSERT OR IGNORE INTO _migrations (id) VALUES (?)", [id]);
}

/** Initial schema — tables for a fresh database. */
const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
  hostname TEXT, path TEXT, description TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('online', 'offline', 'starting', 'stopping', 'restarting', 'deploying', 'maintenance', 'unknown')),
  metadata TEXT DEFAULT '{}',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  locked_by TEXT, locked_at TEXT, last_heartbeat TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS server_operations (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  agent_id TEXT, session_id TEXT,
  operation_type TEXT NOT NULL CHECK(operation_type IN ('start', 'stop', 'restart', 'deploy', 'configure', 'status_check', 'custom')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT, error_message TEXT, metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  operation_id TEXT REFERENCES server_operations(id) ON DELETE SET NULL,
  agent_id TEXT, event TEXT NOT NULL, details TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
  capabilities TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  metadata TEXT DEFAULT '{}', session_id TEXT, working_dir TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT, working_dir TEXT, metadata TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS resource_locks (
  resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, lock_type TEXT NOT NULL,
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '[]',
  secret TEXT, active INTEGER NOT NULL DEFAULT 1,
  project_id TEXT,
  server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  operation_id TEXT REFERENCES server_operations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL, payload TEXT NOT NULL,
  status_code INTEGER, response TEXT, attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** Incremental migrations — each string is run in order, tracked by _migrations.id. */
export const MIGRATIONS: string[] = [
  // 1 — Base schema (run once, ensureSchema fills any gaps)
  INITIAL_SCHEMA,

  // 2 — Add heartbeat tracking index
  `CREATE INDEX IF NOT EXISTS idx_servers_heartbeat ON servers(last_heartbeat) WHERE last_heartbeat IS NOT NULL`,

  // 3 — Add operation session index
  `CREATE INDEX IF NOT EXISTS idx_operations_session ON server_operations(session_id) WHERE session_id IS NOT NULL`,

  // 4 — Add webhook active index
  `CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active) WHERE active = 1`,
];

export function applyMigrations(db: Database): void {
  // Record each migration as it runs so we can resume
  try {
    const result = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number | null } | null;
    const currentLevel = result?.max_id ?? 0;

    for (let i = currentLevel; i < MIGRATIONS.length; i++) {
      db.exec(MIGRATIONS[i]!);
      recordMigration(db, i + 1);
    }
  } catch {
    // First run — _migrations table doesn't exist yet
    for (let i = 0; i < MIGRATIONS.length; i++) {
      try { db.exec(MIGRATIONS[i]!); } catch {}
      recordMigration(db, i + 1);
    }
  }
}
