import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import {
  closeDatabase,
  getDatabase,
  resetDatabase,
} from "../db/database.js";
import { createServer, getServer } from "../db/servers.js";
import { listOperations } from "../db/operations.js";
import { checkLock } from "../db/locks.js";
import {
  detectProjectServerConfig,
  getLocalServerSnapshot,
  startLocalServer,
  stopLocalServer,
} from "./local-server.js";

function setup() {
  process.env["SERVERS_DB_PATH"] = ":memory:";
  resetDatabase();
  getDatabase();
}

function teardown() {
  closeDatabase();
  delete process.env["SERVERS_DB_PATH"];
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "servers-local-test-"));
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForPidExit(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidRunning(pid);
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createHttpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

describe("detectProjectServerConfig", () => {
  it("detects a Bun JavaScript app from package.json scripts", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "bun.lock"), "");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { dev: "next dev --hostname 0.0.0.0" } }),
      );

      const detected = detectProjectServerConfig(dir, { port: 3007 });

      expect(detected.command).toBe("bun run dev");
      expect(detected.cwd).toBe(dir);
      expect(detected.port).toBe(3007);
      expect(detected.healthUrl).toBe("http://127.0.0.1:3007");
      expect(detected.metadata.detected_from).toContain("package.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a Python Django app without JavaScript files", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "manage.py"), "# django");

      const detected = detectProjectServerConfig(dir, { port: 8011 });

      expect(detected.command).toBe("python manage.py runserver 0.0.0.0:8011");
      expect(detected.cwd).toBe(dir);
      expect(detected.port).toBe(8011);
      expect(detected.metadata.detected_from).toBe("manage.py");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("local server lifecycle", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("starts, waits for, records, and stops a local app process safely", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    const db = getDatabase();
    let pid: number | undefined;

    try {
      writeFileSync(
        join(dir, "server.js"),
        `
const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
      );

      const server = createServer({
        name: "test-app",
        status: "offline",
        path: dir,
        metadata: {
          start_command: "bun run server.js",
          cwd: dir,
          port,
          health_url: `http://127.0.0.1:${port}`,
          env: { PORT: String(port) },
        },
      }, db);

      const started = await startLocalServer(server.id, {
        agentId: "agent-1",
        reason: "regression test",
        wait: true,
        readyTimeoutMs: 8000,
      }, db);

      pid = started.pid;
      expect(started.ready).toBe(true);
      expect(started.operation.status).toBe("completed");
      expect(started.server.status).toBe("online");
      expect(started.server.metadata.pid).toBe(pid);
      expect(checkLock("server-runtime", server.id, db)).toBeNull();

      const snapshot = await getLocalServerSnapshot(started.server, { timeoutMs: 1000 });
      expect(snapshot.running).toBe(true);
      expect(snapshot.ready).toBe(true);

      const stopped = await stopLocalServer(server.id, {
        agentId: "agent-1",
        reason: "regression test cleanup",
        wait: true,
        stopTimeoutMs: 8000,
      }, db);

      pid = undefined;
      expect(stopped.operation.status).toBe("completed");
      expect(stopped.server.status).toBe("offline");
      expect(stopped.server.metadata.pid).toBeUndefined();
      expect(listOperations(server.id, undefined, 10, db).map((op) => op.operation_type)).toEqual(["stop", "start"]);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start a server while another agent owns the lifecycle lock", async () => {
    const db = getDatabase();
    const server = createServer({
      name: "locked-app",
      metadata: { start_command: "bun run dev", cwd: process.cwd() },
    }, db);

    const { acquireLock } = await import("../db/locks.js");
    expect(acquireLock("server-runtime", server.id, "agent-1", "exclusive", 30_000, db)).toBe(true);

    await expect(startLocalServer(server.id, {
      agentId: "agent-2",
      reason: "should wait or fail safely",
      waitForLock: false,
    }, db)).rejects.toThrow("locked by agent-1");

    const refreshed = getServer(server.id, db)!;
    expect(refreshed.status).toBe("unknown");
  });

  it("cleans up a spawned process when readiness fails", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    const db = getDatabase();

    try {
      writeFileSync(
        join(dir, "server.js"),
        `
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(process.cwd(), "pid.txt"), String(process.pid));
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
      );

      const server = createServer({
        name: "never-ready-app",
        status: "offline",
        path: dir,
        metadata: {
          start_command: "bun run server.js",
          cwd: dir,
          port,
          health_url: `http://127.0.0.1:${port}`,
        },
      }, db);

      await expect(startLocalServer(server.id, {
        agentId: "agent-1",
        wait: true,
        readyTimeoutMs: 300,
      }, db)).rejects.toThrow("did not become ready");

      const pid = Number.parseInt(readFileSync(join(dir, "pid.txt"), "utf-8"), 10);
      expect(await waitForPidExit(pid)).toBe(true);

      const refreshed = getServer(server.id, db)!;
      expect(refreshed.status).toBe("offline");
      expect(refreshed.metadata.pid).toBeUndefined();
      expect(listOperations(server.id, "failed", 10, db)).toHaveLength(1);
      expect(checkLock("server-runtime", server.id, db)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
