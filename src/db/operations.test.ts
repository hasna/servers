import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
} from "./database.js";
import {
  createOperation,
  getOperation,
  listOperations,
  updateOperation,
  startOperation,
  completeOperation,
  failOperation,
  cancelOperation,
  deleteOperation,
} from "./operations.js";
import { createServer } from "./servers.js";
import { OperationNotFoundError } from "../types/index.js";

function setup() {
  process.env["SERVERS_DB_PATH"] = ":memory:";
  resetDatabase();
  const db = getDatabase();
  return { db };
}

function teardown() {
  closeDatabase();
  delete process.env["SERVERS_DB_PATH"];
}

function createTestServer(name = "test") {
  return createServer({ name });
}

describe("createOperation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("creates an operation with minimal fields", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    expect(op.id).toBeTruthy();
    expect(op.server_id).toBe(s.id);
    expect(op.operation_type).toBe("start");
    expect(op.status).toBe("pending");
    expect(op.agent_id).toBeNull();
    expect(op.completed_at).toBeNull();
    expect(op.error_message).toBeNull();
  });

  it("creates an operation with agent and session", () => {
    const s = createTestServer();
    const op = createOperation({
      server_id: s.id,
      operation_type: "deploy",
      agent_id: "agent-1",
      session_id: "sess-1",
      metadata: { version: "1.0" },
    });
    expect(op.agent_id).toBe("agent-1");
    expect(op.session_id).toBe("sess-1");
    expect(op.metadata).toEqual({ version: "1.0" });
  });

  it("defaults metadata to empty object", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "restart" });
    expect(op.metadata).toEqual({});
  });
});

describe("getOperation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the operation by id", () => {
    const s = createTestServer();
    const created = createOperation({ server_id: s.id, operation_type: "start" });
    const found = getOperation(created.id)!;
    expect(found.id).toBe(created.id);
  });

  it("returns null for non-existent id", () => {
    expect(getOperation("nonexistent")).toBeNull();
  });
});

describe("listOperations", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("lists all operations", () => {
    const s = createTestServer();
    createOperation({ server_id: s.id, operation_type: "start" });
    createOperation({ server_id: s.id, operation_type: "stop" });
    expect(listOperations().length).toBe(2);
  });

  it("filters by server_id", () => {
    const s1 = createTestServer("a");
    const s2 = createTestServer("b");
    createOperation({ server_id: s1.id, operation_type: "start" });
    createOperation({ server_id: s2.id, operation_type: "stop" });
    expect(listOperations(s1.id).length).toBe(1);
  });

  it("filters by status", () => {
    const s = createTestServer();
    const op1 = createOperation({ server_id: s.id, operation_type: "start" });
    createOperation({ server_id: s.id, operation_type: "stop" });
    updateOperation(op1.id, { status: "completed" });
    expect(listOperations(undefined, "completed").length).toBe(1);
  });

  it("filters by server_id and status", () => {
    const s1 = createTestServer("a");
    const s2 = createTestServer("b");
    const op = createOperation({ server_id: s1.id, operation_type: "start" });
    createOperation({ server_id: s1.id, operation_type: "stop" });
    createOperation({ server_id: s2.id, operation_type: "start" });
    updateOperation(op.id, { status: "completed" });
    expect(listOperations(s1.id, "completed").length).toBe(1);
  });

  it("respects limit", () => {
    const s = createTestServer();
    for (let i = 0; i < 5; i++) {
      createOperation({ server_id: s.id, operation_type: "start" });
    }
    expect(listOperations(undefined, undefined, 3).length).toBe(3);
  });

  it("orders by started_at descending", () => {
    const db = getDatabase();
    const s = createTestServer();
    const first = createOperation({ server_id: s.id, operation_type: "start" });
    // Make the first operation appear older
    db.run("UPDATE server_operations SET started_at = datetime('now', '-1 second') WHERE id = ?", [first.id]);
    createOperation({ server_id: s.id, operation_type: "stop" });
    const list = listOperations();
    expect(list[0]!.id).not.toBe(first.id);
  });

  it("returns empty array when no operations", () => {
    expect(listOperations()).toEqual([]);
  });
});

describe("updateOperation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("updates status", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    const updated = updateOperation(op.id, { status: "running" });
    expect(updated.status).toBe("running");
  });

  it("updates completed_at", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    const completed = new Date().toISOString();
    const updated = updateOperation(op.id, { status: "pending", completed_at: completed });
    expect(updated.completed_at).toBe(completed);
  });

  it("updates error_message", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    const updated = updateOperation(op.id, { status: "pending", error_message: "something broke" });
    expect(updated.error_message).toBe("something broke");
  });

  it("throws OperationNotFoundError for non-existent id", () => {
    expect(() => updateOperation("fake", { status: "running" })).toThrow(OperationNotFoundError);
  });
});

describe("startOperation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("sets status to running", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    const started = startOperation(op.id);
    expect(started.status).toBe("running");
  });

  it("throws for non-existent id", () => {
    expect(() => startOperation("fake")).toThrow(OperationNotFoundError);
  });
});

describe("completeOperation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("sets status to completed with completed_at", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    const completed = completeOperation(op.id);
    expect(completed.status).toBe("completed");
    expect(completed.completed_at).toBeTruthy();
  });

  it("throws for non-existent id", () => {
    expect(() => completeOperation("fake")).toThrow(OperationNotFoundError);
  });
});

describe("failOperation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("sets status to failed with error_message", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    const failed = failOperation(op.id, "disk full");
    expect(failed.status).toBe("failed");
    expect(failed.error_message).toBe("disk full");
    expect(failed.completed_at).toBeTruthy();
  });

  it("throws for non-existent id", () => {
    expect(() => failOperation("fake", "err")).toThrow(OperationNotFoundError);
  });
});

describe("cancelOperation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("sets status to cancelled with completed_at", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    const cancelled = cancelOperation(op.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completed_at).toBeTruthy();
  });

  it("throws for non-existent id", () => {
    expect(() => cancelOperation("fake")).toThrow(OperationNotFoundError);
  });
});

describe("deleteOperation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("deletes an operation", () => {
    const s = createTestServer();
    const op = createOperation({ server_id: s.id, operation_type: "start" });
    expect(deleteOperation(op.id)).toBe(true);
    expect(getOperation(op.id)).toBeNull();
  });

  it("throws OperationNotFoundError for non-existent id", () => {
    expect(() => deleteOperation("fake")).toThrow(OperationNotFoundError);
  });
});
