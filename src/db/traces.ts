import type { Database } from "bun:sqlite";
import { Trace, TraceRow, CreateTraceInput } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

function rowToTrace(row: TraceRow): Trace {
  return {
    ...row,
    details: JSON.parse(row.details || "{}"),
    operation_id: row.operation_id || null,
    agent_id: row.agent_id || null,
  };
}

export function createTrace(input: CreateTraceInput, db?: Database): Trace {
  const d = db || getDatabase();
  const id = uuid();

  d.run(
    `INSERT INTO traces (id, server_id, operation_id, agent_id, event, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.server_id,
      input.operation_id || null,
      input.agent_id || null,
      input.event,
      JSON.stringify(input.details || {}),
      now(),
    ],
  );
  return getTrace(id, d)!;
}

export function getTrace(id: string, db?: Database): Trace | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM traces WHERE id = ?").get(id) as TraceRow | null;
  return row ? rowToTrace(row) : null;
}

export function listTraces(
  serverId?: string,
  operationId?: string | null,
  limit = 100,
  db?: Database,
): Trace[] {
  const d = db || getDatabase();
  let rows: TraceRow[];

  if (serverId && operationId) {
    rows = d.query(
      "SELECT * FROM traces WHERE server_id = ? AND operation_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(serverId, operationId, limit) as TraceRow[];
  } else if (serverId) {
    rows = d.query(
      "SELECT * FROM traces WHERE server_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(serverId, limit) as TraceRow[];
  } else if (operationId) {
    rows = d.query(
      "SELECT * FROM traces WHERE operation_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(operationId, limit) as TraceRow[];
  } else {
    rows = d.query(
      "SELECT * FROM traces ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as TraceRow[];
  }
  return rows.map(rowToTrace);
}

export function listTracesByAgent(agentId: string, limit = 50, db?: Database): Trace[] {
  const d = db || getDatabase();
  const rows = d.query(
    "SELECT * FROM traces WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(agentId, limit) as TraceRow[];
  return rows.map(rowToTrace);
}

export function deleteTracesByServer(serverId: string, db?: Database): number {
  const d = db || getDatabase();
  return d.run("DELETE FROM traces WHERE server_id = ?", [serverId]).changes;
}
