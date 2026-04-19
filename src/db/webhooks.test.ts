import { describe, it, expect, beforeEach, afterEach, spyOn, afterAll } from "bun:test";
import {
  getDatabase,
  closeDatabase,
  resetDatabase,
} from "./database.js";
import {
  validateWebhookUrl,
  createWebhook,
  getWebhook,
  listWebhooks,
  deleteWebhook,
  listDeliveries,
  dispatchWebhook,
} from "./webhooks.js";

function setup() {
  process.env["SERVERS_DB_PATH"] = ":memory:";
  resetDatabase();
  return { db: getDatabase() };
}

function teardown() {
  closeDatabase();
  delete process.env["SERVERS_DB_PATH"];
}

// ── validateWebhookUrl ─────────────────────────────────────────────────────

describe("validateWebhookUrl", () => {
  it("accepts a valid HTTPS URL", () => {
    expect(validateWebhookUrl("https://example.com/hook")).toEqual({ valid: true });
  });

  it("rejects HTTP URLs", () => {
    const r = validateWebhookUrl("http://example.com/hook");
    expect(r.valid).toBe(false);
    expect((r as any).error).toBe("Webhook URLs must use HTTPS");
  });

  it("rejects localhost URLs", () => {
    const r = validateWebhookUrl("https://localhost:8080/hook");
    expect(r.valid).toBe(false);
    expect((r as any).error).toContain("localhost");
  });

  it("rejects 127.0.0.1 URLs", () => {
    const r = validateWebhookUrl("https://127.0.0.1/hook");
    expect(r.valid).toBe(false);
  });

  it("rejects ::1 URLs", () => {
    const r = validateWebhookUrl("https://[::1]/hook");
    expect(r.valid).toBe(false);
    expect((r as any).error).toContain("localhost");
  });

  it("rejects 0.0.0.0 URLs", () => {
    const r = validateWebhookUrl("https://0.0.0.0/hook");
    expect(r.valid).toBe(false);
  });

  it("rejects cloud metadata endpoint", () => {
    const r = validateWebhookUrl("https://169.254.169.254/latest/meta-data/");
    expect(r.valid).toBe(false);
    expect((r as any).error).toContain("cloud metadata");
  });

  it("rejects 169.254.x.x range", () => {
    const r = validateWebhookUrl("https://169.254.1.1/hook");
    expect(r.valid).toBe(false);
  });

  it("rejects private 10.x.x.x range", () => {
    const r = validateWebhookUrl("https://10.0.0.1/hook");
    expect(r.valid).toBe(false);
  });

  it("rejects private 172.16-31.x.x range", () => {
    expect(validateWebhookUrl("https://172.16.0.1/hook").valid).toBe(false);
    expect(validateWebhookUrl("https://172.31.255.255/hook").valid).toBe(false);
  });

  it("rejects private 192.168.x.x range", () => {
    const r = validateWebhookUrl("https://192.168.1.1/hook");
    expect(r.valid).toBe(false);
  });

  it("rejects 127.x.x.x range", () => {
    const r = validateWebhookUrl("https://127.1.2.3/hook");
    expect(r.valid).toBe(false);
  });

  it("rejects invalid URLs", () => {
    const r = validateWebhookUrl("not-a-url");
    expect(r.valid).toBe(false);
    expect((r as any).error).toContain("Invalid");
  });
});

// ── isPrivateOrInternal (tested via validateWebhookUrl for URL strings, but the function itself) ──
// The function is internal, so we test via URL validation above.

// ── createWebhook ───────────────────────────────────────────────────────────

describe("createWebhook", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("creates a webhook with minimal fields", () => {
    const wh = createWebhook({ url: "https://example.com/hook" });
    expect(wh.id).toBeTruthy();
    expect(wh.url).toBe("https://example.com/hook");
    expect(wh.events).toEqual([]);
    expect(wh.secret).toBeNull();
    expect(wh.active).toBe(true);
    expect(wh.project_id).toBeNull();
  });

  it("creates a webhook with all fields", () => {
    const wh = createWebhook({
      url: "https://hooks.example.com/notify",
      events: ["server.started", "server.stopped"],
      secret: "my-secret",
      project_id: "proj-1",
    });
    expect(wh.events).toEqual(["server.started", "server.stopped"]);
    expect(wh.secret).toBe("my-secret");
    expect(wh.project_id).toBe("proj-1");
  });

  it("rejects HTTP URLs", () => {
    expect(() => createWebhook({ url: "http://example.com/hook" })).toThrow("Invalid webhook URL");
  });

  it("rejects localhost URLs", () => {
    expect(() => createWebhook({ url: "https://localhost/hook" })).toThrow("Invalid webhook URL");
  });
});

// ── getWebhook ──────────────────────────────────────────────────────────────

describe("getWebhook", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns the webhook by id", () => {
    const created = createWebhook({ url: "https://example.com/hook" });
    const found = getWebhook(created.id)!;
    expect(found.id).toBe(created.id);
  });

  it("returns null for non-existent id", () => {
    expect(getWebhook("nonexistent")).toBeNull();
  });
});

// ── listWebhooks ────────────────────────────────────────────────────────────

describe("listWebhooks", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("lists all webhooks", () => {
    createWebhook({ url: "https://a.com/hook" });
    createWebhook({ url: "https://b.com/hook" });
    expect(listWebhooks().length).toBe(2);
  });

  it("returns empty array when no webhooks", () => {
    expect(listWebhooks()).toEqual([]);
  });

  it("orders by created_at descending", () => {
    const first = createWebhook({ url: "https://a.com/hook" });
    const db = getDatabase();
    // Make the first webhook appear newer by setting created_at in the past
    db.run("UPDATE webhooks SET created_at = datetime('now', '-1 second') WHERE id = ?", [first.id]);
    createWebhook({ url: "https://b.com/hook" });
    const list = listWebhooks();
    expect(list[0]!.url).toBe("https://b.com/hook");
    expect(list[1]!.url).toBe("https://a.com/hook");
  });
});

// ── deleteWebhook ───────────────────────────────────────────────────────────

describe("deleteWebhook", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("deletes a webhook", () => {
    const wh = createWebhook({ url: "https://example.com/hook" });
    expect(deleteWebhook(wh.id)).toBe(true);
    expect(getWebhook(wh.id)).toBeNull();
  });

  it("returns false for non-existent id", () => {
    expect(deleteWebhook("nonexistent")).toBe(false);
  });
});

// ── listDeliveries ──────────────────────────────────────────────────────────

describe("listDeliveries", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("lists all deliveries", () => {
    const wh = createWebhook({ url: "https://example.com/hook" });
    // We can't create deliveries directly without the internal logDelivery function
    // But we can verify the query works with an empty table
    expect(listDeliveries()).toEqual([]);
  });

  it("filters by webhook_id", () => {
    expect(listDeliveries("wh-1")).toEqual([]);
  });

  it("respects limit", () => {
    expect(listDeliveries(undefined, 5).length).toBe(0);
  });
});

// ── dispatchWebhook ────────────────────────────────────────────────────────

describe("dispatchWebhook", () => {
  let dnsSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setup();
    dnsSpy = spyOn(Bun.dns, "lookup");
    dnsSpy.mockResolvedValue({ address: "93.184.216.34", family: 4 } as any);
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response("ok", { status: 204 }) as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    dnsSpy.mockRestore();
    teardown();
  });

  it("dispatches to matching webhooks and records delivery", async () => {
    createWebhook({
      url: "https://example.com/hook",
      events: ["server.started"],
    });
    await dispatchWebhook("server.started", { server_id: "srv-1" });
    const deliveries = listDeliveries();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status_code).toBe(204);
  });

  it("does not dispatch to webhooks with non-matching events", async () => {
    createWebhook({
      url: "https://example.com/hook",
      events: ["server.stopped"],
    });
    await dispatchWebhook("server.started", { server_id: "srv-1" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listDeliveries()).toEqual([]);
  });

  it("dispatches to webhooks with no event filter (empty events)", async () => {
    createWebhook({
      url: "https://example.com/hook",
      events: [],
    });
    await dispatchWebhook("any.event", { server_id: "srv-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(listDeliveries()).toHaveLength(1);
  });

  it("does not dispatch inactive webhooks", async () => {
    const wh = createWebhook({ url: "https://example.com/hook" });
    const db = getDatabase();
    db.run("UPDATE webhooks SET active = 0 WHERE id = ?", [wh.id]);
    await dispatchWebhook("server.started", { server_id: "srv-1" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listDeliveries()).toEqual([]);
  });

  it("does not dispatch to webhook with non-matching server_id scope", async () => {
    const { createServer } = await import("./servers.js");
    const server = createServer({ name: "test-srv" });
    createWebhook({
      url: "https://example.com/hook",
      events: ["server.started"],
      server_id: server.id,
    });
    await dispatchWebhook("server.started", { server_id: "some-other-id" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listDeliveries()).toEqual([]);
  });

  it("dispatches to webhook with matching server_id scope", async () => {
    const { createServer } = await import("./servers.js");
    const server = createServer({ name: "test-srv" });
    createWebhook({
      url: "https://example.com/hook",
      events: ["server.started"],
      server_id: server.id,
    });
    await dispatchWebhook("server.started", { server_id: server.id });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(listDeliveries()).toHaveLength(1);
  });

  it("handles non-object payload gracefully", async () => {
    createWebhook({
      url: "https://example.com/hook",
      events: ["server.started"],
    });
    await dispatchWebhook("server.started", "not an object");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(listDeliveries()).toHaveLength(1);
  });

  it("handles null payload gracefully", async () => {
    createWebhook({
      url: "https://example.com/hook",
      events: ["server.started"],
    });
    await dispatchWebhook("server.started", null);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(listDeliveries()).toHaveLength(1);
  });
});
