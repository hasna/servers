/**
 * PostgreSQL migrations for open-servers remote storage.
 *
 * These mirror the SQLite schema column-for-column where possible so
 * local-first data can sync without depending on a shared storage runtime.
 */
export const PG_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    capabilities TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    metadata TEXT DEFAULT '{}',
    session_id TEXT,
    working_dir TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    last_seen_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    hostname TEXT,
    path TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('online', 'offline', 'starting', 'stopping', 'restarting', 'deploying', 'maintenance', 'unknown')),
    metadata TEXT DEFAULT '{}',
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    locked_by TEXT,
    locked_at TEXT,
    last_heartbeat TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT NOW()::text,
    ended_at TEXT,
    working_dir TEXT,
    metadata TEXT DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS server_operations (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    agent_id TEXT,
    session_id TEXT,
    operation_type TEXT NOT NULL CHECK(operation_type IN ('start', 'stop', 'restart', 'deploy', 'configure', 'status_check', 'custom')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    started_at TEXT NOT NULL DEFAULT NOW()::text,
    completed_at TEXT,
    error_message TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    operation_id TEXT REFERENCES server_operations(id) ON DELETE SET NULL,
    agent_id TEXT,
    event TEXT NOT NULL,
    details TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS resource_locks (
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    lock_type TEXT NOT NULL,
    locked_at TEXT NOT NULL DEFAULT NOW()::text,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (resource_type, resource_id)
  )`,

  `CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    secret TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    project_id TEXT,
    server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    operation_id TEXT REFERENCES server_operations(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status_code INTEGER,
    response TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE INDEX IF NOT EXISTS idx_servers_project ON servers(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status)`,
  `CREATE INDEX IF NOT EXISTS idx_servers_slug ON servers(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_servers_locked ON servers(locked_by) WHERE locked_by IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_servers_heartbeat ON servers(last_heartbeat) WHERE last_heartbeat IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_operations_server ON server_operations(server_id)`,
  `CREATE INDEX IF NOT EXISTS idx_operations_status ON server_operations(status)`,
  `CREATE INDEX IF NOT EXISTS idx_operations_agent ON server_operations(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_operations_session ON server_operations(session_id) WHERE session_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_traces_server ON traces(server_id)`,
  `CREATE INDEX IF NOT EXISTS idx_traces_operation ON traces(operation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_traces_event ON traces(event)`,
  `CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name)`,
  `CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id) WHERE session_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_sessions_session ON agent_sessions(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_resource_locks_agent ON resource_locks(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_resource_locks_expires ON resource_locks(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_webhooks_project ON webhooks(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_webhooks_server ON webhooks(server_id)`,
  `CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active) WHERE active = TRUE`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id)`,
];
