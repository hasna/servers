import type { Database } from "bun:sqlite";
import {
  Server,
  ServerRow,
  CreateServerInput,
  UpdateServerInput,
  ServerNotFoundError,
  ServerLockedError,
} from "../types/index.js";
import { getDatabase, now, uuid, isLockExpired, clearExpiredLocks } from "./database.js";

function rowToServer(row: ServerRow): Server {
  return {
    ...row,
    status: row.status as Server["status"],
    metadata: JSON.parse(row.metadata || "{}"),
    locked_by: row.locked_by || null,
    locked_at: row.locked_at || null,
    last_heartbeat: row.last_heartbeat || null,
    project_id: row.project_id || null,
    hostname: row.hostname || null,
    path: row.path || null,
    description: row.description || null,
  };
}

export function createServer(input: CreateServerInput, db?: Database): Server {
  const d = db || getDatabase();
  const id = uuid();
  const slug = (input.slug || input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 63);
  const t = now();

  d.run(
    `INSERT INTO servers (id, name, slug, hostname, path, description, status, metadata, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      slug,
      input.hostname || null,
      input.path || null,
      input.description || null,
      input.status || "unknown",
      JSON.stringify(input.metadata || {}),
      input.project_id || null,
      t,
      t,
    ],
  );
  return getServer(id, d)!;
}

export function getServer(id: string, db?: Database): Server | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | null;
  return row ? rowToServer(row) : null;
}

export function getServerBySlug(slug: string, db?: Database): Server | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM servers WHERE slug = ?").get(slug) as ServerRow | null;
  return row ? rowToServer(row) : null;
}

export function listServers(projectId?: string, db?: Database): Server[] {
  const d = db || getDatabase();
  clearExpiredLocks(d);

  let rows: ServerRow[];
  if (projectId) {
    rows = d.query("SELECT * FROM servers WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as ServerRow[];
  } else {
    rows = d.query("SELECT * FROM servers ORDER BY created_at DESC").all() as ServerRow[];
  }
  return rows.map(rowToServer);
}

export function updateServer(id: string, input: UpdateServerInput, db?: Database): Server {
  const d = db || getDatabase();
  const existing = getServer(id, d);
  if (!existing) throw new ServerNotFoundError(id);

  const parts: string[] = [];
  const values: (string | number | null)[] = [];

  if (input.name !== undefined) { parts.push("name = ?"); values.push(input.name); }
  if (input.slug !== undefined) { parts.push("slug = ?"); values.push(input.slug); }
  if (input.hostname !== undefined) { parts.push("hostname = ?"); values.push(input.hostname); }
  if (input.path !== undefined) { parts.push("path = ?"); values.push(input.path); }
  if (input.description !== undefined) { parts.push("description = ?"); values.push(input.description); }
  if (input.status !== undefined) { parts.push("status = ?"); values.push(input.status); }
  if (input.metadata !== undefined) { parts.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }
  if (input.project_id !== undefined) { parts.push("project_id = ?"); values.push(input.project_id); }
  if (input.last_heartbeat !== undefined) { parts.push("last_heartbeat = ?"); values.push(input.last_heartbeat); }

  parts.push("updated_at = ?");
  values.push(now());
  values.push(id);

  d.run(`UPDATE servers SET ${parts.join(", ")} WHERE id = ?`, values);
  return getServer(id, d)!;
}

export function deleteServer(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const existing = getServer(id, d);
  if (!existing) throw new ServerNotFoundError(id);

  // Can't delete a locked server
  if (existing.locked_by && !isLockExpired(existing.locked_at)) {
    throw new ServerLockedError(id, existing.locked_by);
  }

  return d.run("DELETE FROM servers WHERE id = ?", [id]).changes > 0;
}

export function lockServer(serverId: string, agentId: string, db?: Database): Server {
  const d = db || getDatabase();
  const existing = getServer(serverId, d);
  if (!existing) throw new ServerNotFoundError(serverId);

  // Already locked by same agent — extend
  if (existing.locked_by === agentId && !isLockExpired(existing.locked_at)) {
    return updateServer(serverId, {}, d);
  }

  // Locked by another agent
  if (existing.locked_by && !isLockExpired(existing.locked_at)) {
    throw new ServerLockedError(serverId, existing.locked_by);
  }

  // Clear expired lock and acquire
  d.run(
    "UPDATE servers SET locked_by = ?, locked_at = ? WHERE id = ?",
    [agentId, now(), serverId],
  );
  return getServer(serverId, d)!;
}

export function unlockServer(serverId: string, agentId: string, db?: Database): Server {
  const d = db || getDatabase();
  const existing = getServer(serverId, d);
  if (!existing) throw new ServerNotFoundError(serverId);

  if (existing.locked_by !== agentId) {
    throw new ServerLockedError(serverId, existing.locked_by || "unknown");
  }

  d.run(
    "UPDATE servers SET locked_by = NULL, locked_at = NULL WHERE id = ?",
    [serverId],
  );
  return getServer(serverId, d)!;
}

export function heartbeatServer(serverId: string, db?: Database): Server {
  const d = db || getDatabase();
  const existing = getServer(serverId, d);
  if (!existing) throw new ServerNotFoundError(serverId);

  return updateServer(serverId, { last_heartbeat: now() }, d);
}
