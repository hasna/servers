import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
  LOCK_EXPIRY_MINUTES,
} from "./database.js";
import {
  createServer,
  getServer,
  getServerBySlug,
  listServers,
  updateServer,
  deleteServer,
  lockServer,
  unlockServer,
  heartbeatServer,
} from "./servers.js";
import { createProject } from "./projects.js";
import { ServerNotFoundError, ServerLockedError } from "../types/index.js";

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

describe("createServer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("creates a server with minimal fields", () => {
    const s = createServer({ name: "api-server" });
    expect(s.id).toBeTruthy();
    expect(s.name).toBe("api-server");
    expect(s.slug).toBe("api-server");
    expect(s.status).toBe("unknown");
    expect(s.metadata).toEqual({});
    expect(s.locked_by).toBeNull();
    expect(s.project_id).toBeNull();
  });

  it("creates a server with all fields", () => {
    const proj = createProject({ name: "test-proj", path: "/tmp/test" });
    const s = createServer({
      name: "Web App",
      slug: "web-app",
      hostname: "app.example.com",
      path: "/opt/app",
      description: "Main web application",
      status: "online",
      metadata: { port: 3000 },
      project_id: proj.id,
    });
    expect(s.name).toBe("Web App");
    expect(s.slug).toBe("web-app");
    expect(s.hostname).toBe("app.example.com");
    expect(s.path).toBe("/opt/app");
    expect(s.description).toBe("Main web application");
    expect(s.status).toBe("online");
    expect(s.metadata).toEqual({ port: 3000 });
    expect(s.project_id).toBe(proj.id);
  });

  it("auto-generates slug from name", () => {
    const s = createServer({ name: "My Cool Server!" });
    expect(s.slug).toBe("my-cool-server");
  });

  it("uses provided slug over auto-generated", () => {
    const s = createServer({ name: "My Server", slug: "custom-slug" });
    expect(s.slug).toBe("custom-slug");
  });

  it("truncates slug to 63 chars", () => {
    const longName = "a".repeat(100);
    const s = createServer({ name: longName });
    expect(s.slug.length).toBe(63);
  });
});

describe("getServer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the server by id", () => {
    const created = createServer({ name: "test" });
    const found = getServer(created.id)!;
    expect(found.id).toBe(created.id);
  });

  it("returns null for non-existent id", () => {
    expect(getServer("nonexistent")).toBeNull();
  });
});

describe("getServerBySlug", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the server by slug", () => {
    createServer({ name: "Test Server", slug: "test-srv" });
    const found = getServerBySlug("test-srv")!;
    expect(found.name).toBe("Test Server");
  });

  it("returns null for non-existent slug", () => {
    expect(getServerBySlug("nope")).toBeNull();
  });
});

describe("listServers", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns all servers when no filter", () => {
    createServer({ name: "a" });
    createServer({ name: "b" });
    const list = listServers();
    expect(list.length).toBe(2);
  });

  it("filters by project_id", () => {
    const p1 = createProject({ name: "project-a", path: "/a" });
    const p2 = createProject({ name: "project-b", path: "/b" });
    createServer({ name: "a", project_id: p1.id });
    createServer({ name: "b", project_id: p2.id });
    createServer({ name: "c" });
    expect(listServers(p1.id).length).toBe(1);
    expect(listServers(p2.id).length).toBe(1);
    expect(listServers(p1.id)[0]!.name).toBe("a");
  });

  it("returns empty array when no servers", () => {
    expect(listServers()).toEqual([]);
  });

  it("clears expired locks on list", () => {
    const db = getDatabase();
    const s = createServer({ name: "test" });
    db.run("UPDATE servers SET locked_by = 'agent-1', locked_at = datetime('now', '-60 minutes') WHERE id = ?", [s.id]);
    const list = listServers();
    expect(list[0]!.locked_by).toBeNull();
  });
});

describe("updateServer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("updates name", () => {
    const s = createServer({ name: "old" });
    const updated = updateServer(s.id, { name: "new" });
    expect(updated.name).toBe("new");
  });

  it("updates status", () => {
    const s = createServer({ name: "test" });
    const updated = updateServer(s.id, { status: "online" });
    expect(updated.status).toBe("online");
  });

  it("updates metadata", () => {
    const s = createServer({ name: "test" });
    const updated = updateServer(s.id, { metadata: { version: "2.0" } });
    expect(updated.metadata).toEqual({ version: "2.0" });
  });

  it("updates multiple fields at once", () => {
    const s = createServer({ name: "old" });
    const updated = updateServer(s.id, { name: "new", status: "online", description: "desc" });
    expect(updated.name).toBe("new");
    expect(updated.status).toBe("online");
    expect(updated.description).toBe("desc");
  });

  it("throws ServerNotFoundError for non-existent id", () => {
    expect(() => updateServer("fake", { name: "x" })).toThrow(ServerNotFoundError);
  });

  it("updates last_heartbeat", () => {
    const s = createServer({ name: "test" });
    const hb = new Date().toISOString();
    const updated = updateServer(s.id, { last_heartbeat: hb });
    expect(updated.last_heartbeat).toBe(hb);
  });

  it("updates updated_at timestamp", () => {
    const s = createServer({ name: "test" });
    const old = s.updated_at;
    const updated = updateServer(s.id, { name: "new" });
    expect(updated.updated_at >= old).toBe(true);
  });
});

describe("deleteServer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("deletes an unlocked server", () => {
    const s = createServer({ name: "test" });
    expect(deleteServer(s.id)).toBe(true);
    expect(getServer(s.id)).toBeNull();
  });

  it("throws ServerNotFoundError for non-existent id", () => {
    expect(() => deleteServer("fake")).toThrow(ServerNotFoundError);
  });

  it("throws ServerLockedError when locked", () => {
    const db = getDatabase();
    const s = createServer({ name: "test" });
    db.run("UPDATE servers SET locked_by = 'agent-1', locked_at = datetime('now') WHERE id = ?", [s.id]);
    expect(() => deleteServer(s.id)).toThrow(ServerLockedError);
  });

  it("allows delete when lock is expired", () => {
    const db = getDatabase();
    const s = createServer({ name: "test" });
    db.run("UPDATE servers SET locked_by = 'agent-1', locked_at = datetime('now', '-60 minutes') WHERE id = ?", [s.id]);
    expect(deleteServer(s.id)).toBe(true);
  });
});

describe("lockServer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("acquires a lock on an unlocked server", () => {
    const s = createServer({ name: "test" });
    const locked = lockServer(s.id, "agent-1");
    expect(locked.locked_by).toBe("agent-1");
    expect(locked.locked_at).toBeTruthy();
  });

  it("throws ServerLockedError when locked by another agent", () => {
    const s = createServer({ name: "test" });
    lockServer(s.id, "agent-1");
    expect(() => lockServer(s.id, "agent-2")).toThrow(ServerLockedError);
  });

  it("allows same agent to extend lock", () => {
    const s = createServer({ name: "test" });
    const first = lockServer(s.id, "agent-1");
    const second = lockServer(s.id, "agent-1");
    expect(second.locked_by).toBe("agent-1");
    expect(second.locked_at! >= first.locked_at!).toBe(true);
  });

  it("allows lock takeover when expired", () => {
    const db = getDatabase();
    const s = createServer({ name: "test" });
    db.run("UPDATE servers SET locked_by = 'agent-1', locked_at = datetime('now', '-60 minutes') WHERE id = ?", [s.id]);
    const locked = lockServer(s.id, "agent-2");
    expect(locked.locked_by).toBe("agent-2");
  });

  it("throws ServerNotFoundError for non-existent server", () => {
    expect(() => lockServer("fake", "agent-1")).toThrow(ServerNotFoundError);
  });
});

describe("unlockServer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("unlocks a server when called by the locking agent", () => {
    const s = createServer({ name: "test" });
    lockServer(s.id, "agent-1");
    const unlocked = unlockServer(s.id, "agent-1");
    expect(unlocked.locked_by).toBeNull();
    expect(unlocked.locked_at).toBeNull();
  });

  it("throws ServerLockedError when called by a different agent", () => {
    const s = createServer({ name: "test" });
    lockServer(s.id, "agent-1");
    expect(() => unlockServer(s.id, "agent-2")).toThrow(ServerLockedError);
  });

  it("throws ServerNotFoundError for non-existent server", () => {
    expect(() => unlockServer("fake", "agent-1")).toThrow(ServerNotFoundError);
  });

  it("throws when server is not locked", () => {
    const s = createServer({ name: "test" });
    expect(() => unlockServer(s.id, "agent-1")).toThrow(ServerLockedError);
  });
});

describe("heartbeatServer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("updates last_heartbeat", () => {
    const s = createServer({ name: "test" });
    const before = s.last_heartbeat;
    const updated = heartbeatServer(s.id);
    expect(updated.last_heartbeat).toBeTruthy();
    if (before) {
      expect(updated.last_heartbeat! >= before!).toBe(true);
    }
  });

  it("throws ServerNotFoundError for non-existent server", () => {
    expect(() => heartbeatServer("fake")).toThrow(ServerNotFoundError);
  });
});
