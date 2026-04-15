import type { Database } from "bun:sqlite";
import {
  ServerOperation,
  ServerOperationRow,
  CreateOperationInput,
  UpdateOperationInput,
  OperationNotFoundError,
} from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

function rowToOperation(row: ServerOperationRow): ServerOperation {
  return {
    ...row,
    operation_type: row.operation_type as ServerOperation["operation_type"],
    status: row.status as ServerOperation["status"],
    metadata: JSON.parse(row.metadata || "{}"),
    agent_id: row.agent_id || null,
    session_id: row.session_id || null,
    completed_at: row.completed_at || null,
    error_message: row.error_message || null,
  };
}

export function createOperation(input: CreateOperationInput, db?: Database): ServerOperation {
  const d = db || getDatabase();
  const id = uuid();
  const t = now();

  d.run(
    `INSERT INTO server_operations (id, server_id, agent_id, session_id, operation_type, status, started_at, metadata)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      input.server_id,
      input.agent_id || null,
      input.session_id || null,
      input.operation_type,
      t,
      JSON.stringify(input.metadata || {}),
    ],
  );
  return getOperation(id, d)!;
}

export function getOperation(id: string, db?: Database): ServerOperation | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM server_operations WHERE id = ?").get(id) as ServerOperationRow | null;
  return row ? rowToOperation(row) : null;
}

export function listOperations(serverId?: string, status?: string, limit = 50, db?: Database): ServerOperation[] {
  const d = db || getDatabase();
  let rows: ServerOperationRow[];

  if (serverId && status) {
    rows = d.query(
      "SELECT * FROM server_operations WHERE server_id = ? AND status = ? ORDER BY started_at DESC LIMIT ?",
    ).all(serverId, status, limit) as ServerOperationRow[];
  } else if (serverId) {
    rows = d.query(
      "SELECT * FROM server_operations WHERE server_id = ? ORDER BY started_at DESC LIMIT ?",
    ).all(serverId, limit) as ServerOperationRow[];
  } else if (status) {
    rows = d.query(
      "SELECT * FROM server_operations WHERE status = ? ORDER BY started_at DESC LIMIT ?",
    ).all(status, limit) as ServerOperationRow[];
  } else {
    rows = d.query(
      "SELECT * FROM server_operations ORDER BY started_at DESC LIMIT ?",
    ).all(limit) as ServerOperationRow[];
  }
  return rows.map(rowToOperation);
}

export function updateOperation(id: string, input: UpdateOperationInput, db?: Database): ServerOperation {
  const d = db || getDatabase();
  const existing = getOperation(id, d);
  if (!existing) throw new OperationNotFoundError(id);

  const parts: string[] = [];
  const values: (string | number | null)[] = [];

  if (input.status !== undefined) { parts.push("status = ?"); values.push(input.status); }
  if (input.completed_at !== undefined) { parts.push("completed_at = ?"); values.push(input.completed_at); }
  if (input.error_message !== undefined) { parts.push("error_message = ?"); values.push(input.error_message); }

  values.push(id);
  d.run(`UPDATE server_operations SET ${parts.join(", ")} WHERE id = ?`, values);

  return getOperation(id, d)!;
}

export function startOperation(id: string, db?: Database): ServerOperation {
  return updateOperation(id, { status: "running" }, db);
}

export function completeOperation(id: string, db?: Database): ServerOperation {
  return updateOperation(id, { status: "completed", completed_at: now() }, db);
}

export function failOperation(id: string, errorMessage: string, db?: Database): ServerOperation {
  return updateOperation(id, { status: "failed", completed_at: now(), error_message: errorMessage }, db);
}

export function cancelOperation(id: string, db?: Database): ServerOperation {
  return updateOperation(id, { status: "cancelled", completed_at: now() }, db);
}

export function deleteOperation(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const existing = getOperation(id, d);
  if (!existing) throw new OperationNotFoundError(id);
  return d.run("DELETE FROM server_operations WHERE id = ?", [id]).changes > 0;
}
