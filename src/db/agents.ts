import type { Database } from "bun:sqlite";
import {
  Agent,
  AgentRow,
  RegisterAgentInput,
  AgentConflictError,
  AgentNotFoundError,
} from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

const STALE_MINUTES = 30;

function rowToAgent(row: AgentRow): Agent {
  return {
    ...row,
    capabilities: JSON.parse(row.capabilities || "[]"),
    status: row.status as Agent["status"],
    metadata: JSON.parse(row.metadata || "{}"),
    description: row.description || null,
    session_id: row.session_id || null,
    working_dir: row.working_dir || null,
  };
}

function isStale(lastSeenAt: string): boolean {
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  return ageMs > STALE_MINUTES * 60 * 1000;
}

export function registerAgent(input: RegisterAgentInput, db?: Database): Agent {
  const d = db || getDatabase();
  const t = now();

  // Check if agent exists by name
  const existing = d.query("SELECT * FROM agents WHERE name = ?").get(input.name) as AgentRow | null;

  if (existing) {
    const agent = rowToAgent(existing);

    // Same agent re-registering (same session or returning)
    if (agent.session_id === input.session_id) {
      d.run(
        "UPDATE agents SET last_seen_at = ?, working_dir = ? WHERE id = ?",
        [t, input.working_dir || agent.working_dir, agent.id],
      );
      return getAgent(agent.id, d)!;
    }

    // Different session — check if stale
    if (isStale(agent.last_seen_at)) {
      // Stale agent — take over
      d.run(
        "UPDATE agents SET session_id = ?, working_dir = ?, last_seen_at = ?, status = 'active' WHERE id = ?",
        [input.session_id || null, input.working_dir || null, t, agent.id],
      );
      return getAgent(agent.id, d)!;
    }

    // Active agent with different session — conflict
    throw {
      conflict: true,
      existing_id: agent.id,
      existing_name: agent.name,
      last_seen_at: agent.last_seen_at,
      session_hint: agent.session_id,
      working_dir: agent.working_dir,
      message: `Agent "${input.name}" is already active (session: ${agent.session_id ?? "unknown"}, last seen: ${agent.last_seen_at}). Wait for it to expire (${STALE_MINUTES} min) or use force: true.`,
    } as AgentConflictError;
  }

  // New agent
  const id = uuid();
  const capabilities = JSON.stringify(input.capabilities || []);

  d.run(
    `INSERT INTO agents (id, name, description, capabilities, status, metadata, session_id, working_dir, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, ?, ?)`,
    [id, input.name, input.description || null, capabilities, input.session_id || null, input.working_dir || null, t, t],
  );
  return getAgent(id, d)!;
}

export function getAgent(id: string, db?: Database): Agent | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | null;
  return row ? rowToAgent(row) : null;
}

export function getAgentByName(name: string, db?: Database): Agent | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM agents WHERE name = ?").get(name) as AgentRow | null;
  return row ? rowToAgent(row) : null;
}

export function getAgentBySession(sessionId: string, db?: Database): Agent | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM agents WHERE session_id = ?").get(sessionId) as AgentRow | null;
  return row ? rowToAgent(row) : null;
}

export function listAgents(status?: string, db?: Database): Agent[] {
  const d = db || getDatabase();
  let rows: AgentRow[];

  if (status) {
    rows = d.query("SELECT * FROM agents WHERE status = ? ORDER BY last_seen_at DESC").all(status) as AgentRow[];
  } else {
    rows = d.query("SELECT * FROM agents ORDER BY last_seen_at DESC").all() as AgentRow[];
  }
  return rows.map(rowToAgent);
}

export function updateAgent(id: string, updates: { description?: string | null; capabilities?: string[]; session_id?: string | null; working_dir?: string | null; metadata?: Record<string, unknown> }, db?: Database): Agent {
  const d = db || getDatabase();
  const existing = getAgent(id, d);
  if (!existing) throw new AgentNotFoundError(id);

  const parts: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.description !== undefined) { parts.push("description = ?"); values.push(updates.description); }
  if (updates.capabilities !== undefined) { parts.push("capabilities = ?"); values.push(JSON.stringify(updates.capabilities)); }
  if (updates.session_id !== undefined) { parts.push("session_id = ?"); values.push(updates.session_id); }
  if (updates.working_dir !== undefined) { parts.push("working_dir = ?"); values.push(updates.working_dir); }
  if (updates.metadata !== undefined) { parts.push("metadata = ?"); values.push(JSON.stringify(updates.metadata)); }

  parts.push("last_seen_at = ?");
  values.push(now());
  values.push(id);

  d.run(`UPDATE agents SET ${parts.join(", ")} WHERE id = ?`, values);
  return getAgent(id, d)!;
}

export function heartbeatAgent(id: string, db?: Database): Agent {
  const d = db || getDatabase();
  const existing = getAgent(id, d);
  if (!existing) throw new AgentNotFoundError(id);

  d.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", [now(), id]);
  return getAgent(id, d)!;
}

export function archiveAgent(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const existing = getAgent(id, d);
  if (!existing) throw new AgentNotFoundError(id);

  d.run("UPDATE agents SET status = 'archived', session_id = NULL WHERE id = ?", [id]);
  return true;
}

export function releaseAgent(id: string, db?: Database): Agent {
  const d = db || getDatabase();
  const existing = getAgent(id, d);
  if (!existing) throw new AgentNotFoundError(id);

  d.run("UPDATE agents SET session_id = NULL, last_seen_at = ? WHERE id = ?", [now(), id]);
  return getAgent(id, d)!;
}
