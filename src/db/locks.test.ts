import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
} from "./database.js";
import {
  acquireLock,
  releaseLock,
  checkLock,
  cleanExpiredLocks,
  getLocksByAgent,
} from "./locks.js";

function setup() {
  process.env["SERVERS_DB_PATH"] = ":memory:";
  resetDatabase();
  return { db: getDatabase() };
}

function teardown() {
  closeDatabase();
  delete process.env["SERVERS_DB_PATH"];
}

describe("acquireLock", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("acquires a new lock", () => {
    const result = acquireLock("server", "srv-1", "agent-1");
    expect(result).toBe(true);
  });

  it("acquires an exclusive lock", () => {
    const result = acquireLock("server", "srv-1", "agent-1", "exclusive");
    expect(result).toBe(true);
  });

  it("allows same agent to re-acquire (extend)", () => {
    acquireLock("server", "srv-1", "agent-1");
    const result = acquireLock("server", "srv-1", "agent-1");
    expect(result).toBe(true);
  });

  it("prevents different agent from acquiring advisory lock", () => {
    acquireLock("server", "srv-1", "agent-1");
    const result = acquireLock("server", "srv-1", "agent-2");
    expect(result).toBe(false);
  });

  it("prevents different agent from acquiring exclusive lock", () => {
    acquireLock("server", "srv-1", "agent-1", "exclusive");
    const result = acquireLock("server", "srv-1", "agent-2");
    expect(result).toBe(false);
  });

  it("uses custom expiry", () => {
    const db = getDatabase();
    const result = acquireLock("server", "srv-1", "agent-1", "advisory", 5000, db);
    expect(result).toBe(true);
    const lock = db.query("SELECT * FROM resource_locks WHERE resource_id = 'srv-1'").get() as { expires_at: string } | null;
    expect(lock).toBeTruthy();
    // expires_at should be ~5 seconds from now
    const expiresMs = Date.parse(lock!.expires_at);
    const diff = expiresMs - Date.now();
    expect(diff).toBeLessThan(10000);
    expect(diff).toBeGreaterThan(-1000);
  });

  it("acquires locks for different resources independently", () => {
    acquireLock("server", "srv-1", "agent-1");
    const result = acquireLock("server", "srv-2", "agent-2");
    expect(result).toBe(true);
  });

  it("acquires locks for different resource types independently", () => {
    acquireLock("server", "srv-1", "agent-1");
    const result = acquireLock("config", "srv-1", "agent-2");
    expect(result).toBe(true);
  });
});

describe("releaseLock", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("releases a lock owned by the agent", () => {
    acquireLock("server", "srv-1", "agent-1");
    const result = releaseLock("server", "srv-1", "agent-1");
    expect(result).toBe(true);
    expect(checkLock("server", "srv-1")).toBeNull();
  });

  it("returns false when agent doesn't own the lock", () => {
    acquireLock("server", "srv-1", "agent-1");
    const result = releaseLock("server", "srv-1", "agent-2");
    expect(result).toBe(false);
  });

  it("returns false when no lock exists", () => {
    const result = releaseLock("server", "nonexistent", "agent-1");
    expect(result).toBe(false);
  });
});

describe("checkLock", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the lock info when locked", () => {
    acquireLock("server", "srv-1", "agent-1", "advisory");
    const lock = checkLock("server", "srv-1")!;
    expect(lock.agent_id).toBe("agent-1");
    expect(lock.resource_type).toBe("server");
    expect(lock.resource_id).toBe("srv-1");
    expect(lock.lock_type).toBe("advisory");
  });

  it("returns null when not locked", () => {
    expect(checkLock("server", "free")).toBeNull();
  });

  it("returns null when lock is expired", () => {
    const db = getDatabase();
    acquireLock("server", "srv-1", "agent-1", "advisory", 10, db); // 10ms expiry
    // Wait for expiry
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const lock = checkLock("server", "srv-1");
        expect(lock).toBeNull();
        resolve();
      }, 50);
    });
  });
});

describe("cleanExpiredLocks", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("removes expired locks", () => {
    const db = getDatabase();
    acquireLock("server", "srv-1", "agent-1", "advisory", 10, db); // 10ms expiry
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const cleaned = cleanExpiredLocks(db);
        expect(cleaned).toBe(1);
        expect(checkLock("server", "srv-1")).toBeNull();
        resolve();
      }, 50);
    });
  });

  it("keeps non-expired locks", () => {
    acquireLock("server", "srv-1", "agent-1");
    const cleaned = cleanExpiredLocks();
    expect(cleaned).toBe(0);
    expect(checkLock("server", "srv-1")).toBeTruthy();
  });

  it("returns 0 when no locks exist", () => {
    expect(cleanExpiredLocks()).toBe(0);
  });
});

describe("getLocksByAgent", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns all locks for an agent", () => {
    acquireLock("server", "srv-1", "agent-1");
    acquireLock("config", "cfg-1", "agent-1");
    acquireLock("server", "srv-2", "agent-2");
    const locks = getLocksByAgent("agent-1");
    expect(locks.length).toBe(2);
    expect(locks.every(l => l.agent_id === "agent-1")).toBe(true);
  });

  it("returns empty array when agent has no locks", () => {
    acquireLock("server", "srv-1", "agent-1");
    expect(getLocksByAgent("agent-2")).toEqual([]);
  });

  it("excludes expired locks", () => {
    const db = getDatabase();
    acquireLock("server", "srv-1", "agent-1", "advisory", 10, db);
    acquireLock("server", "srv-2", "agent-1"); // non-expiring (5 min)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const locks = getLocksByAgent("agent-1");
        expect(locks.length).toBe(1);
        expect(locks[0]!.resource_id).toBe("srv-2");
        resolve();
      }, 50);
    });
  });
});
