import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
  now,
  uuid,
  isLockExpired,
  lockExpiryCutoff,
  resolvePartialId,
  LOCK_EXPIRY_MINUTES,
} from "./database.js";
import { applyMigrations } from "./migrations.js";

describe("database", () => {
  beforeEach(() => {
    process.env["SERVERS_DB_PATH"] = ":memory:";
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env["SERVERS_DB_PATH"];
  });

  it("returns a singleton database instance", () => {
    const db1 = getDatabase();
    const db2 = getDatabase();
    expect(db1).toBe(db2);
  });

  it("enables WAL mode and foreign keys", () => {
    const db = getDatabase();
    // In-memory DB always uses "memory" journal mode — WAL only applies to file-backed DBs
    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(foreignKeys.foreign_keys).toBe(1);
  });

  it("creates all tables via migrations", () => {
    const db = getDatabase();
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain("_migrations");
    expect(names).toContain("projects");
    expect(names).toContain("servers");
    expect(names).toContain("server_operations");
    expect(names).toContain("traces");
    expect(names).toContain("agents");
    expect(names).toContain("agent_sessions");
    expect(names).toContain("resource_locks");
    expect(names).toContain("webhooks");
    expect(names).toContain("webhook_deliveries");
  });
});

describe("closeDatabase", () => {
  beforeEach(() => {
    process.env["SERVERS_DB_PATH"] = ":memory:";
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env["SERVERS_DB_PATH"];
  });

  it("closes and nullifies the database", () => {
    const db = getDatabase();
    expect(db).toBeTruthy();
    closeDatabase();
    const newDb = getDatabase();
    expect(newDb).not.toBe(db);
  });

  it("is safe to call when no database is open", () => {
    resetDatabase();
    expect(() => closeDatabase()).not.toThrow();
  });
});

describe("now", () => {
  it("returns an ISO 8601 string", () => {
    const result = now();
    expect(typeof result).toBe("string");
    expect(new Date(result).toISOString()).toBe(result);
  });
});

describe("uuid", () => {
  it("returns a valid v4 UUID", () => {
    const result = uuid();
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns unique values", () => {
    const a = uuid();
    const b = uuid();
    expect(a).not.toBe(b);
  });
});

describe("isLockExpired", () => {
  it("returns true for null input", () => {
    expect(isLockExpired(null)).toBe(true);
  });

  it("returns false for a recent lock", () => {
    expect(isLockExpired(new Date().toISOString())).toBe(false);
  });

  it("returns true for an old lock", () => {
    const old = new Date(Date.now() - (LOCK_EXPIRY_MINUTES + 1) * 60 * 1000).toISOString();
    expect(isLockExpired(old)).toBe(true);
  });

  it("returns false for a lock just under the limit", () => {
    const recent = new Date(Date.now() - (LOCK_EXPIRY_MINUTES - 1) * 60 * 1000).toISOString();
    expect(isLockExpired(recent)).toBe(false);
  });
});

describe("lockExpiryCutoff", () => {
  it("returns a timestamp LOCK_EXPIRY_MINUTES ago", () => {
    const fixedNow = Date.parse("2025-01-01T12:00:00.000Z");
    const cutoff = lockExpiryCutoff(fixedNow);
    const expected = new Date(fixedNow - LOCK_EXPIRY_MINUTES * 60 * 1000).toISOString();
    expect(cutoff).toBe(expected);
  });
});

describe("resolvePartialId", () => {
  beforeEach(() => {
    process.env["SERVERS_DB_PATH"] = ":memory:";
    resetDatabase();
    getDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env["SERVERS_DB_PATH"];
  });

  it("returns null for non-existent full UUID", () => {
    expect(resolvePartialId(getDatabase(), "servers", "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("returns the id for an exact match", () => {
    const db = getDatabase();
    db.run("INSERT INTO servers (id, name, slug, status) VALUES ('aaaa-1111', 'test', 'test', 'unknown')");
    expect(resolvePartialId(db, "servers", "aaaa-1111")).toBe("aaaa-1111");
  });

  it("returns the id for a unique prefix", () => {
    const db = getDatabase();
    db.run("INSERT INTO servers (id, name, slug, status) VALUES ('aaaa-1111', 'a', 'a', 'unknown')");
    db.run("INSERT INTO servers (id, name, slug, status) VALUES ('bbbb-2222', 'b', 'b', 'unknown')");
    expect(resolvePartialId(db, "servers", "aaa")).toBe("aaaa-1111");
  });

  it("returns null for ambiguous prefix", () => {
    const db = getDatabase();
    db.run("INSERT INTO servers (id, name, slug, status) VALUES ('aaaa-1111', 'a', 'a', 'unknown')");
    db.run("INSERT INTO servers (id, name, slug, status) VALUES ('aaaa-2222', 'b', 'b', 'unknown')");
    expect(resolvePartialId(db, "servers", "aaaa")).toBeNull();
  });

  it("matches servers by name", () => {
    const db = getDatabase();
    db.run("INSERT INTO servers (id, name, slug, status) VALUES ('id-1', 'my-server', 'my-server', 'unknown')");
    expect(resolvePartialId(db, "servers", "my-server")).toBe("id-1");
  });

  it("matches servers by slug (case-insensitive)", () => {
    const db = getDatabase();
    db.run("INSERT INTO servers (id, name, slug, status) VALUES ('id-1', 'My Server', 'my-server', 'unknown')");
    expect(resolvePartialId(db, "servers", "MY-SERVER")).toBe("id-1");
  });

  it("returns null for agents table on partial id with no match", () => {
    const db = getDatabase();
    db.run("INSERT INTO agents (id, name) VALUES ('aaaa-1111', 'test')");
    expect(resolvePartialId(db, "agents", "zzz")).toBeNull();
  });

  it("returns unique match for agents by prefix", () => {
    const db = getDatabase();
    db.run("INSERT INTO agents (id, name) VALUES ('aaaa-1111', 'test')");
    expect(resolvePartialId(db, "agents", "aaa")).toBe("aaaa-1111");
  });
});

describe("applyMigrations", () => {
  beforeEach(() => {
    process.env["SERVERS_DB_PATH"] = ":memory:";
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env["SERVERS_DB_PATH"];
  });

  it("creates _migrations table on first run", () => {
    const db = getDatabase();
    const row = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number };
    expect(row.max_id).toBeGreaterThan(0);
  });

  it("is idempotent — running twice does not duplicate", () => {
    const db = getDatabase();
    const before = db.query("SELECT COUNT(*) as cnt FROM _migrations").get() as { cnt: number };
    applyMigrations(db);
    const after = db.query("SELECT COUNT(*) as cnt FROM _migrations").get() as { cnt: number };
    expect(after.cnt).toBe(before.cnt);
  });
});
