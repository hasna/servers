import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  restartLocalServer,
  startLocalServer,
  stopLocalServer,
} from "./local-server.js";

setDefaultTimeout(10_000);

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

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function processStat(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
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

describe("getLocalServerSnapshot", () => {
  it("reports a zombie-only pid as offline", async () => {
    const dir = makeTempDir();
    const pidFile = join(dir, "child.pid");
    let parentPid: number | undefined;

    try {
      const parent = spawn(
        "bash",
        ["-lc", "sleep 0.1 & echo $! > \"$1\"; exec sleep 30", "_", pidFile],
        { stdio: "ignore" },
      );
      parentPid = parent.pid!;

      expect(await waitFor(() => !!parentPid && isPidRunning(parentPid))).toBe(true);
      expect(await waitFor(() => existsSync(pidFile))).toBe(true);
      const childPid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
      expect(await waitFor(() => processStat(childPid).startsWith("Z"))).toBe(true);

      const snapshot = await getLocalServerSnapshot({
        id: "zombie-only",
        name: "Zombie Only",
        slug: "zombie-only",
        hostname: null,
        path: dir,
        description: null,
        status: "online",
        metadata: { pid: childPid },
        project_id: null,
        locked_by: null,
        locked_at: null,
        last_heartbeat: null,
        created_at: "2026-06-21T00:00:00.000Z",
        updated_at: "2026-06-21T00:00:00.000Z",
      }, { timeoutMs: 50 });

      expect(snapshot.running).toBe(false);
      expect(snapshot.ready).toBe(false);
      expect(snapshot.status).toBe("offline");
    } finally {
      if (parentPid) {
        try {
          process.kill(parentPid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
          start_command: "exec bun run server.js",
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
          start_command: "exec bun run server.js",
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

  it("fails fast with log output when the start command exits before readiness", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    const db = getDatabase();
    const logFile = join(dir, "early-exit.log");

    try {
      writeFileSync(
        join(dir, "exit.js"),
        `
console.error("early startup failure");
process.exit(42);
`,
      );

      const server = createServer({
        name: "early-exit-app",
        status: "offline",
        path: dir,
        metadata: {
          start_command: "exec bun run exit.js",
          cwd: dir,
          port,
          health_url: `http://127.0.0.1:${port}`,
          log_file: logFile,
        },
      }, db);

      const startedAt = Date.now();
      await expect(startLocalServer(server.id, {
        agentId: "agent-1",
        wait: true,
        readyTimeoutMs: 5000,
      }, db)).rejects.toThrow(/exited before server became ready.*early startup failure/s);

      expect(Date.now() - startedAt).toBeLessThan(3000);
      const refreshed = getServer(server.id, db)!;
      expect(refreshed.status).toBe("offline");
      expect(refreshed.metadata.pid).toBeUndefined();
      expect(listOperations(server.id, "failed", 10, db)).toHaveLength(1);
      expect(checkLock("server-runtime", server.id, db)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stop with wait false sends SIGTERM without force-killing or marking offline", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    const db = getDatabase();
    let pid: number | undefined;

    try {
      writeFileSync(
        join(dir, "server.js"),
        `
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
writeFileSync(join(process.cwd(), "pid.txt"), String(process.pid));
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => {
  writeFileSync(join(process.cwd(), "term.txt"), "term");
  setTimeout(() => {
    writeFileSync(join(process.cwd(), "graceful.txt"), "graceful");
    process.exit(0);
  }, 500);
});
`,
      );

      const server = createServer({
        name: "no-wait-stop-app",
        status: "offline",
        path: dir,
        metadata: {
          start_command: "exec bun run server.js",
          cwd: dir,
          port,
          health_url: `http://127.0.0.1:${port}`,
          env: { PORT: String(port) },
        },
      }, db);

      const started = await startLocalServer(server.id, {
        agentId: "agent-1",
        wait: true,
        readyTimeoutMs: 8000,
      }, db);
      pid = started.pid;

      const before = Date.now();
      const stopped = await stopLocalServer(server.id, {
        agentId: "agent-1",
        wait: false,
        stopTimeoutMs: 2000,
      }, db);
      const elapsedMs = Date.now() - before;

      expect(elapsedMs).toBeLessThan(400);
      expect(stopped.server.status).toBe("stopping");
      expect(stopped.server.metadata.pid).toBe(pid);
      expect(readFileSync(join(dir, "term.txt"), "utf-8")).toBe("term");
      expect(await waitForPidExit(pid!, 2000)).toBe(true);
      expect(readFileSync(join(dir, "graceful.txt"), "utf-8")).toBe("graceful");
      pid = undefined;
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills the entire process tree on stop even when a child escapes the process group", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    const db = getDatabase();
    let childPid: number | undefined;

    try {
      // wrapper.js spawns a detached grandchild (its OWN process group / session),
      // like `bunx next dev` spawning a `node next dev` worker that detaches.
      // The wrapper exits on SIGTERM; the grandchild keeps holding the port and
      // ignores SIGTERM. A correct stop must still take the whole tree down.
      writeFileSync(
        join(dir, "wrapper.js"),
        `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const port = Number(process.env.PORT);
const childSrc = [
  "const http = require('node:http');",
  "process.on('SIGTERM', () => {});",      // grandchild ignores plain SIGTERM
  "const s = http.createServer((_q, r) => r.end('ok'));",
  "s.listen(" + port + ", '127.0.0.1');",
  "setInterval(() => {}, 1000);",
].join("\\n");
const child = spawn(process.execPath, ["-e", childSrc], { stdio: "ignore", detached: true });
child.unref();
writeFileSync(join(process.cwd(), "child.txt"), String(child.pid));
writeFileSync(join(process.cwd(), "wrapper.txt"), String(process.pid));
process.on("SIGTERM", () => { process.exit(0); }); // wrapper (group leader) dies on SIGTERM
setInterval(() => {}, 1000);
`,
      );

      const server = createServer({
        name: "escaping-child-app",
        status: "offline",
        path: dir,
        metadata: {
          // No leading exec: bash is the group leader, node wrapper a child,
          // and the grandchild detaches into its own group.
          start_command: "node wrapper.js",
          cwd: dir,
          port,
          health_url: `http://127.0.0.1:${port}`,
          env: { PORT: String(port) },
        },
      }, db);

      const started = await startLocalServer(server.id, {
        agentId: "agent-1",
        wait: true,
        readyTimeoutMs: 8000,
      }, db);
      expect(started.ready).toBe(true);

      childPid = Number.parseInt(readFileSync(join(dir, "child.txt"), "utf-8"), 10);
      expect(isPidRunning(childPid)).toBe(true);

      const stopped = await stopLocalServer(server.id, {
        agentId: "agent-1",
        reason: "regression: escaping child must die",
        wait: true,
        stopTimeoutMs: 4000,
      }, db);

      // The whole tree must be gone, and the server must be reported stopped.
      expect(await waitForPidExit(childPid, 4000)).toBe(true);
      expect(isPidRunning(childPid)).toBe(false);
      expect(stopped.server.status).toBe("offline");
      expect(stopped.operation.status).toBe("completed");
      expect(stopped.server.metadata.pid).toBeUndefined();
      // Port must no longer be held by the dead tree.
      expect(stopped.snapshot.ready).toBe(false);
      childPid = undefined;
    } finally {
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("force-kills a SIGTERM-ignoring tree by default and verifies the port is freed", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    const db = getDatabase();
    let childPid: number | undefined;

    try {
      // A wrapper that detaches a SIGTERM-ignoring listener into its own group.
      // The default stop must escalate SIGTERM -> SIGKILL (no --force required)
      // and confirm the port is no longer held before reporting success.
      writeFileSync(
        join(dir, "wrapper.js"),
        `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const port = Number(process.env.PORT);
const childSrc = [
  "const http=require('node:http');",
  "process.on('SIGTERM',()=>{});", // child ignores SIGTERM, only SIGKILL stops it
  "const s=http.createServer((_q,r)=>r.end('ok'));",
  "s.listen(" + port + ",'127.0.0.1');",
  "setInterval(()=>{},1000);",
].join("\\n");
const child = spawn(process.execPath, ["-e", childSrc], { stdio: "ignore", detached: true });
child.unref();
writeFileSync(join(process.cwd(), "child.txt"), String(child.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      );

      const server = createServer({
        name: "sigterm-ignoring-app",
        status: "offline",
        path: dir,
        metadata: {
          start_command: "node wrapper.js",
          cwd: dir,
          port,
          health_url: `http://127.0.0.1:${port}`,
          env: { PORT: String(port) },
        },
      }, db);

      const started = await startLocalServer(server.id, {
        agentId: "agent-1",
        wait: true,
        readyTimeoutMs: 8000,
      }, db);
      expect(started.ready).toBe(true);
      childPid = Number.parseInt(readFileSync(join(dir, "child.txt"), "utf-8"), 10);
      expect(isPidRunning(childPid)).toBe(true);

      // No --force flag: default stop must still SIGKILL after the grace period.
      const stopped = await stopLocalServer(server.id, {
        agentId: "agent-1",
        wait: true,
        stopTimeoutMs: 500,
      }, db);

      expect(stopped.operation.status).toBe("completed");
      expect(stopped.server.status).toBe("offline");
      expect(await waitForPidExit(childPid, 4000)).toBe(true);
      expect(isPidRunning(childPid)).toBe(false);
      childPid = undefined;
    } finally {
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not spawn a replacement when restart cannot stop the old process without force", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    const db = getDatabase();
    let pid: number | undefined;

    try {
      writeFileSync(
        join(dir, "server.js"),
        `
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
appendFileSync(join(process.cwd(), "pids.txt"), String(process.pid) + "\\n");
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => {});
`,
      );

      const server = createServer({
        name: "restart-stubborn-app",
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
        wait: true,
        readyTimeoutMs: 8000,
      }, db);
      pid = started.pid;

      await expect(restartLocalServer(server.id, {
        agentId: "agent-1",
        stopTimeoutMs: 250,
        readyTimeoutMs: 1000,
      }, db)).rejects.toThrow("did not stop");

      const pids = readFileSync(join(dir, "pids.txt"), "utf-8").trim().split("\n");
      expect(pids).toEqual([String(pid)]);
      expect(isPidRunning(pid!)).toBe(true);
      const refreshed = getServer(server.id, db)!;
      expect(refreshed.metadata.pid).toBe(pid);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for a forced restart kill before starting the replacement", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    const db = getDatabase();
    let pid: number | undefined;

    try {
      writeFileSync(
        join(dir, "server.js"),
        `
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
appendFileSync(join(process.cwd(), "pids.txt"), String(process.pid) + "\\n");
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => {});
`,
      );

      const server = createServer({
        name: "restart-force-app",
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
        wait: true,
        readyTimeoutMs: 8000,
      }, db);
      const oldPid = started.pid!;
      pid = oldPid;

      const restarted = await restartLocalServer(server.id, {
        agentId: "agent-1",
        stopTimeoutMs: 250,
        readyTimeoutMs: 8000,
        force: true,
      }, db);
      pid = restarted.pid;

      expect(restarted.ready).toBe(true);
      expect(restarted.pid).not.toBe(oldPid);
      expect(await waitForPidExit(oldPid, 1000)).toBe(true);
      const pids = readFileSync(join(dir, "pids.txt"), "utf-8").trim().split("\n");
      expect(pids).toEqual([String(oldPid), String(restarted.pid)]);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
