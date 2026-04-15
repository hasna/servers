import type { Database } from "bun:sqlite";
import { getDatabase, now } from "./database.js";
import type { ResourceLock } from "../types/index.js";

export function acquireLock(
  resourceType: string,
  resourceId: string,
  agentId: string,
  lockType: "advisory" | "exclusive" = "advisory",
  expiryMs: number = 5 * 60 * 1000,
  db?: Database,
): boolean {
  const d = db || getDatabase();
  cleanExpiredLocks(d);

  const existing = d.query(
    "SELECT * FROM resource_locks WHERE resource_type = ? AND resource_id = ?",
  ).get(resourceType, resourceId) as ResourceLock | null;

  if (existing) {
    // Same agent can re-acquire (extend)
    if (existing.agent_id === agentId) {
      const expiresAt = new Date(Date.now() + expiryMs).toISOString();
      d.run(
        "UPDATE resource_locks SET locked_at = ?, expires_at = ? WHERE resource_type = ? AND resource_id = ?",
        [now(), expiresAt, resourceType, resourceId],
      );
      return true;
    }
    return false; // locked by another agent
  }

  const expiresAt = new Date(Date.now() + expiryMs).toISOString();
  try {
    d.run(
      "INSERT INTO resource_locks (resource_type, resource_id, agent_id, lock_type, locked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      [resourceType, resourceId, agentId, lockType, now(), expiresAt],
    );
    return true;
  } catch {
    return false; // UNIQUE constraint = someone else got it
  }
}

export function releaseLock(
  resourceType: string,
  resourceId: string,
  agentId: string,
  db?: Database,
): boolean {
  const d = db || getDatabase();
  const result = d.run(
    "DELETE FROM resource_locks WHERE resource_type = ? AND resource_id = ? AND agent_id = ?",
    [resourceType, resourceId, agentId],
  );
  return result.changes > 0;
}

export function checkLock(
  resourceType: string,
  resourceId: string,
  db?: Database,
): ResourceLock | null {
  const d = db || getDatabase();
  cleanExpiredLocks(d);
  return d.query(
    "SELECT * FROM resource_locks WHERE resource_type = ? AND resource_id = ?",
  ).get(resourceType, resourceId) as ResourceLock | null;
}

export function cleanExpiredLocks(db?: Database): number {
  const d = db || getDatabase();
  const result = d.run(
    "DELETE FROM resource_locks WHERE expires_at < ?",
    [new Date().toISOString()],
  );
  return result.changes;
}

export function getLocksByAgent(agentId: string, db?: Database): ResourceLock[] {
  const d = db || getDatabase();
  cleanExpiredLocks(d);
  return d.query(
    "SELECT * FROM resource_locks WHERE agent_id = ?",
  ).all(agentId) as ResourceLock[];
}
