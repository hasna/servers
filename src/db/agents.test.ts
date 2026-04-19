import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
} from "./database.js";
import {
  registerAgent,
  getAgent,
  getAgentByName,
  getAgentBySession,
  listAgents,
  updateAgent,
  heartbeatAgent,
  archiveAgent,
  releaseAgent,
} from "./agents.js";
import { AgentNotFoundError } from "../types/index.js";

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

describe("registerAgent", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("registers a new agent", () => {
    const agent = registerAgent({ name: "marcus", description: "architect", capabilities: ["review", "design"] });
    expect(agent.id).toBeTruthy();
    expect(agent.name).toBe("marcus");
    expect(agent.status).toBe("active");
    expect(agent.capabilities).toEqual(["review", "design"]);
    expect(agent.session_id).toBeNull();
    expect(agent.working_dir).toBeNull();
  });

  it("registers with session and working_dir", () => {
    const agent = registerAgent({ name: "brutus", session_id: "sess-1", working_dir: "/tmp/project" });
    expect(agent.session_id).toBe("sess-1");
    expect(agent.working_dir).toBe("/tmp/project");
  });

  it("re-registers same agent with same session — extends last_seen", () => {
    const first = registerAgent({ name: "marcus", session_id: "sess-1", working_dir: "/old" });
    const second = registerAgent({ name: "marcus", session_id: "sess-1", working_dir: "/new" });
    expect(second.id).toBe(first.id);
    expect(second.working_dir).toBe("/new");
  });

  it("takes over a stale agent (different session)", () => {
    const db = getDatabase();
    const first = registerAgent({ name: "marcus", session_id: "sess-1" });
    // Manually set last_seen_at to 31 minutes ago
    db.run("UPDATE agents SET last_seen_at = datetime('now', '-31 minutes') WHERE id = ?", [first.id]);
    const second = registerAgent({ name: "marcus", session_id: "sess-2" });
    expect(second.id).toBe(first.id);
    expect(second.session_id).toBe("sess-2");
    expect(second.status).toBe("active");
  });

  it("throws conflict for active agent with different session", () => {
    registerAgent({ name: "marcus", session_id: "sess-1" });
    try {
      registerAgent({ name: "marcus", session_id: "sess-2" });
      throw new Error("Should have thrown");
    } catch (e: any) {
      expect(e.conflict).toBe(true);
      expect(e.existing_name).toBe("marcus");
      expect(e.session_hint).toBe("sess-1");
    }
  });
});

describe("getAgent", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the agent by id", () => {
    const created = registerAgent({ name: "marcus" });
    const found = getAgent(created.id)!;
    expect(found.id).toBe(created.id);
  });

  it("returns null for non-existent id", () => {
    expect(getAgent("nonexistent")).toBeNull();
  });
});

describe("getAgentByName", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the agent by name", () => {
    registerAgent({ name: "marcus" });
    const found = getAgentByName("marcus")!;
    expect(found.name).toBe("marcus");
  });

  it("returns null for non-existent name", () => {
    expect(getAgentByName("nope")).toBeNull();
  });
});

describe("getAgentBySession", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the agent by session_id", () => {
    registerAgent({ name: "marcus", session_id: "sess-1" });
    const found = getAgentBySession("sess-1")!;
    expect(found.session_id).toBe("sess-1");
  });

  it("returns null for non-existent session", () => {
    expect(getAgentBySession("nope")).toBeNull();
  });
});

describe("listAgents", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("lists all agents", () => {
    registerAgent({ name: "marcus" });
    registerAgent({ name: "brutus" });
    expect(listAgents().length).toBe(2);
  });

  it("filters by status", () => {
    registerAgent({ name: "marcus" });
    const b = registerAgent({ name: "brutus" });
    archiveAgent(b.id);
    expect(listAgents("active").length).toBe(1);
    expect(listAgents("archived").length).toBe(1);
  });

  it("returns empty array when no agents", () => {
    expect(listAgents()).toEqual([]);
  });

  it("orders by last_seen_at descending", () => {
    const db = getDatabase();
    registerAgent({ name: "marcus" });
    const b = registerAgent({ name: "brutus" });
    // Make Marcus appear older
    db.run("UPDATE agents SET last_seen_at = datetime('now', '-1 second') WHERE name = 'marcus'");
    const list = listAgents();
    expect(list[0]!.name).toBe("brutus");
  });
});

describe("updateAgent", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("updates session_id", () => {
    const a = registerAgent({ name: "marcus" });
    const updated = updateAgent(a.id, { session_id: "new-sess" });
    expect(updated.session_id).toBe("new-sess");
  });

  it("updates working_dir", () => {
    const a = registerAgent({ name: "marcus" });
    const updated = updateAgent(a.id, { working_dir: "/tmp/new" });
    expect(updated.working_dir).toBe("/tmp/new");
  });

  it("updates description", () => {
    const a = registerAgent({ name: "marcus", description: "old" });
    const updated = updateAgent(a.id, { description: "new" });
    expect(updated.description).toBe("new");
  });

  it("updates capabilities", () => {
    const a = registerAgent({ name: "marcus", capabilities: ["review"] });
    const updated = updateAgent(a.id, { capabilities: ["design", "review"] });
    expect(updated.capabilities).toEqual(["design", "review"]);
  });

  it("updates metadata", () => {
    const a = registerAgent({ name: "marcus" });
    const updated = updateAgent(a.id, { metadata: { key: "value" } });
    expect(updated.metadata).toEqual({ key: "value" });
  });

  it("updates last_seen_at", () => {
    const a = registerAgent({ name: "marcus" });
    const before = a.last_seen_at;
    const updated = updateAgent(a.id, { session_id: "x" });
    expect(updated.last_seen_at >= before).toBe(true);
  });

  it("throws AgentNotFoundError for non-existent id", () => {
    expect(() => updateAgent("fake", { session_id: "x" })).toThrow(AgentNotFoundError);
  });
});

describe("heartbeatAgent", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("updates last_seen_at", () => {
    const a = registerAgent({ name: "marcus" });
    const before = a.last_seen_at;
    const updated = heartbeatAgent(a.id);
    expect(updated.last_seen_at >= before).toBe(true);
  });

  it("throws AgentNotFoundError for non-existent id", () => {
    expect(() => heartbeatAgent("fake")).toThrow(AgentNotFoundError);
  });
});

describe("archiveAgent", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("archives an agent and clears session", () => {
    const a = registerAgent({ name: "marcus", session_id: "sess-1" });
    archiveAgent(a.id);
    const found = getAgent(a.id)!;
    expect(found.status).toBe("archived");
    expect(found.session_id).toBeNull();
  });

  it("throws AgentNotFoundError for non-existent id", () => {
    expect(() => archiveAgent("fake")).toThrow(AgentNotFoundError);
  });
});

describe("releaseAgent", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("clears session_id without archiving", () => {
    const a = registerAgent({ name: "marcus", session_id: "sess-1" });
    const released = releaseAgent(a.id);
    expect(released.session_id).toBeNull();
    expect(released.status).toBe("active");
  });

  it("throws AgentNotFoundError for non-existent id", () => {
    expect(() => releaseAgent("fake")).toThrow(AgentNotFoundError);
  });
});
