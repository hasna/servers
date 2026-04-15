import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
} from "./database.js";
import {
  createTrace,
  getTrace,
  listTraces,
  listTracesByAgent,
  deleteTracesByServer,
} from "./traces.js";
import { createServer } from "./servers.js";
import { createOperation } from "./operations.js";

function setup() {
  process.env["SERVERS_DB_PATH"] = ":memory:";
  resetDatabase();
  return { db: getDatabase() };
}

function teardown() {
  closeDatabase();
  delete process.env["SERVERS_DB_PATH"];
}

describe("createTrace", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("creates a trace with minimal fields", () => {
    const s = createServer({ name: "test" });
    const trace = createTrace({ server_id: s.id, event: "server_started" });
    expect(trace.id).toBeTruthy();
    expect(trace.server_id).toBe(s.id);
    expect(trace.event).toBe("server_started");
    expect(trace.operation_id).toBeNull();
    expect(trace.agent_id).toBeNull();
    expect(trace.details).toEqual({});
    expect(trace.created_at).toBeTruthy();
  });

  it("creates a trace with operation and agent", () => {
    const s = createServer({ name: "test" });
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    const trace = createTrace({
      server_id: s.id,
      operation_id: op.id,
      agent_id: "agent-1",
      event: "deploy_started",
      details: { version: "1.0" },
    });
    expect(trace.operation_id).toBe(op.id);
    expect(trace.agent_id).toBe("agent-1");
    expect(trace.details).toEqual({ version: "1.0" });
  });

  it("defaults details to empty object", () => {
    const s = createServer({ name: "test" });
    const trace = createTrace({ server_id: s.id, event: "heartbeat" });
    expect(trace.details).toEqual({});
  });
});

describe("getTrace", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the trace by id", () => {
    const s = createServer({ name: "test" });
    const created = createTrace({ server_id: s.id, event: "test" });
    const found = getTrace(created.id)!;
    expect(found.id).toBe(created.id);
  });

  it("returns null for non-existent id", () => {
    expect(getTrace("nonexistent")).toBeNull();
  });
});

describe("listTraces", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("lists all traces", () => {
    const s = createServer({ name: "test" });
    createTrace({ server_id: s.id, event: "a" });
    createTrace({ server_id: s.id, event: "b" });
    expect(listTraces().length).toBe(2);
  });

  it("filters by server_id", () => {
    const s1 = createServer({ name: "a" });
    const s2 = createServer({ name: "b" });
    createTrace({ server_id: s1.id, event: "e1" });
    createTrace({ server_id: s2.id, event: "e2" });
    expect(listTraces(s1.id).length).toBe(1);
  });

  it("filters by operation_id", () => {
    const s = createServer({ name: "test" });
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    createTrace({ server_id: s.id, operation_id: op.id, event: "deploy" });
    createTrace({ server_id: s.id, event: "heartbeat" });
    expect(listTraces(undefined, op.id).length).toBe(1);
  });

  it("filters by server_id and operation_id", () => {
    const s1 = createServer({ name: "a" });
    const s2 = createServer({ name: "b" });
    const op1 = createOperation({ server_id: s1.id, operation_type: "start" });
    createTrace({ server_id: s1.id, operation_id: op1.id, event: "deploy" });
    createTrace({ server_id: s1.id, event: "heartbeat" });
    createTrace({ server_id: s2.id, operation_id: null, event: "other" });
    expect(listTraces(s1.id, op1.id).length).toBe(1);
  });

  it("respects limit", () => {
    const s = createServer({ name: "test" });
    for (let i = 0; i < 5; i++) {
      createTrace({ server_id: s.id, event: `e${i}` });
    }
    expect(listTraces(undefined, undefined, 3).length).toBe(3);
  });

  it("orders by created_at descending", () => {
    const db = getDatabase();
    const s = createServer({ name: "test" });
    const first = createTrace({ server_id: s.id, event: "first" });
    db.run("UPDATE traces SET created_at = datetime('now', '-1 second') WHERE id = ?", [first.id]);
    createTrace({ server_id: s.id, event: "second" });
    const list = listTraces();
    expect(list[0]!.id).not.toBe(first.id);
  });

  it("returns empty array when no traces", () => {
    expect(listTraces()).toEqual([]);
  });
});

describe("listTracesByAgent", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("lists traces for a specific agent", () => {
    const s = createServer({ name: "test" });
    createTrace({ server_id: s.id, agent_id: "agent-1", event: "e1" });
    createTrace({ server_id: s.id, agent_id: "agent-2", event: "e2" });
    createTrace({ server_id: s.id, agent_id: "agent-1", event: "e3" });
    const list = listTracesByAgent("agent-1");
    expect(list.length).toBe(2);
    expect(list.every(t => t.agent_id === "agent-1")).toBe(true);
  });

  it("returns empty array when no traces for agent", () => {
    expect(listTracesByAgent("nobody")).toEqual([]);
  });

  it("respects limit", () => {
    const s = createServer({ name: "test" });
    for (let i = 0; i < 5; i++) {
      createTrace({ server_id: s.id, agent_id: "agent-1", event: `e${i}` });
    }
    expect(listTracesByAgent("agent-1", 3).length).toBe(3);
  });

  it("orders by created_at descending", () => {
    const db = getDatabase();
    const s = createServer({ name: "test" });
    const first = createTrace({ server_id: s.id, agent_id: "a1", event: "first" });
    db.run("UPDATE traces SET created_at = datetime('now', '-1 second') WHERE id = ?", [first.id]);
    createTrace({ server_id: s.id, agent_id: "a1", event: "second" });
    const list = listTracesByAgent("a1");
    expect(list[0]!.id).not.toBe(first.id);
  });
});

describe("deleteTracesByServer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("deletes all traces for a server", () => {
    const s1 = createServer({ name: "a" });
    const s2 = createServer({ name: "b" });
    createTrace({ server_id: s1.id, event: "e1" });
    createTrace({ server_id: s1.id, event: "e2" });
    createTrace({ server_id: s2.id, event: "e3" });
    const deleted = deleteTracesByServer(s1.id);
    expect(deleted).toBe(2);
    expect(listTraces().length).toBe(1);
  });

  it("returns 0 when no traces for server", () => {
    const s = createServer({ name: "test" });
    expect(deleteTracesByServer(s.id)).toBe(0);
  });
});
