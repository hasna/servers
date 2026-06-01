import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { acquireLock, releaseLock, checkLock } from "../db/locks.js";
import { getDatabase, now, resolvePartialId } from "../db/database.js";
import {
  getServer,
  getServerBySlug,
  updateServer,
} from "../db/servers.js";
import {
  completeOperation,
  createOperation,
  failOperation,
  startOperation,
} from "../db/operations.js";
import { createTrace } from "../db/traces.js";
import type {
  OperationType,
  Server,
  ServerOperation,
} from "../types/index.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOCK_TTL_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 250;

export interface DetectedProjectServerConfig {
  command: string;
  cwd: string;
  port?: number;
  healthUrl?: string;
  metadata: Record<string, unknown>;
}

export interface DetectProjectServerOptions {
  port?: number;
  healthUrl?: string;
}

export interface LocalServerSnapshot {
  pid: number | null;
  running: boolean;
  ready: boolean;
  status: Server["status"];
  command: string | null;
  cwd: string | null;
  port: number | null;
  healthUrl: string | null;
  logFile: string | null;
  checkedAt: string;
  details: Record<string, unknown>;
}

export interface LocalLifecycleOptions {
  agentId?: string;
  sessionId?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  port?: number;
  healthUrl?: string;
  env?: Record<string, string>;
  wait?: boolean;
  waitForLock?: boolean;
  lockTimeoutMs?: number;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  logFile?: string;
  force?: boolean;
}

export interface LocalLifecycleResult {
  server: Server;
  operation: ServerOperation;
  snapshot: LocalServerSnapshot;
  pid?: number;
  ready: boolean;
}

interface ResolvedLifecycleConfig {
  command: string;
  cwd: string;
  port?: number;
  healthUrl?: string;
  env: Record<string, string>;
  logFile: string;
  readyTimeoutMs: number;
  stopTimeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return undefined;
}

function envValue(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof raw === "string") env[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") env[key] = String(raw);
  }
  return env;
}

function defaultHealthUrl(port?: number): string | undefined {
  return port ? `http://127.0.0.1:${port}` : undefined;
}

function packageManagerCommand(cwd: string, script: "dev" | "start"): string {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return `bun run ${script}`;
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return `pnpm ${script}`;
  if (existsSync(join(cwd, "yarn.lock"))) return `yarn ${script}`;
  if (existsSync(join(cwd, "package-lock.json"))) return `npm run ${script}`;
  return `bun run ${script}`;
}

export function detectProjectServerConfig(
  startDir = process.cwd(),
  options: DetectProjectServerOptions = {},
): DetectedProjectServerConfig {
  const cwd = resolve(startDir);
  const healthUrl = options.healthUrl ?? defaultHealthUrl(options.port);

  const packageJson = join(cwd, "package.json");
  if (existsSync(packageJson)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJson, "utf-8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.dev) {
        return {
          command: packageManagerCommand(cwd, "dev"),
          cwd,
          port: options.port,
          healthUrl,
          metadata: { detected_from: "package.json:scripts.dev", script: pkg.scripts.dev },
        };
      }
      if (pkg.scripts?.start) {
        return {
          command: packageManagerCommand(cwd, "start"),
          cwd,
          port: options.port,
          healthUrl,
          metadata: { detected_from: "package.json:scripts.start", script: pkg.scripts.start },
        };
      }
    } catch {}
  }

  if (existsSync(join(cwd, "manage.py"))) {
    const port = options.port ?? 8000;
    return {
      command: `python manage.py runserver 0.0.0.0:${port}`,
      cwd,
      port,
      healthUrl: options.healthUrl ?? defaultHealthUrl(port),
      metadata: { detected_from: "manage.py" },
    };
  }

  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "requirements.txt"))) {
    const port = options.port ?? 8000;
    return {
      command: `python -m uvicorn main:app --host 0.0.0.0 --port ${port}`,
      cwd,
      port,
      healthUrl: options.healthUrl ?? defaultHealthUrl(port),
      metadata: { detected_from: existsSync(join(cwd, "pyproject.toml")) ? "pyproject.toml" : "requirements.txt" },
    };
  }

  if (existsSync(join(cwd, "Cargo.toml"))) {
    return {
      command: "cargo run",
      cwd,
      port: options.port,
      healthUrl,
      metadata: { detected_from: "Cargo.toml" },
    };
  }

  if (existsSync(join(cwd, "go.mod"))) {
    return {
      command: "go run .",
      cwd,
      port: options.port,
      healthUrl,
      metadata: { detected_from: "go.mod" },
    };
  }

  if (existsSync(join(cwd, "docker-compose.yml")) || existsSync(join(cwd, "compose.yaml")) || existsSync(join(cwd, "compose.yml"))) {
    return {
      command: "docker compose up",
      cwd,
      port: options.port,
      healthUrl,
      metadata: { detected_from: "docker compose" },
    };
  }

  throw new Error(`Could not detect a server command in ${cwd}. Pass --command explicitly.`);
}

function resolveServer(idOrSlug: string, db: Database): Server {
  let server = getServer(idOrSlug, db) || getServerBySlug(idOrSlug, db);
  if (!server) {
    const resolved = resolvePartialId(db, "servers", idOrSlug);
    if (resolved) server = getServer(resolved, db);
  }
  if (!server) throw new Error(`Server not found: ${idOrSlug}`);
  return server;
}

function resolveLifecycleConfig(server: Server, opts: LocalLifecycleOptions = {}): ResolvedLifecycleConfig {
  const cwd = resolve(
    opts.cwd
      ?? stringValue(server.metadata.cwd)
      ?? server.path
      ?? process.cwd(),
  );
  const command = opts.command ?? stringValue(server.metadata.start_command) ?? stringValue(server.metadata.command);
  if (!command) {
    throw new Error(`Server ${server.slug} has no start command. Configure metadata.start_command or pass --command.`);
  }

  const port = opts.port ?? numberValue(server.metadata.port) ?? numberValue(server.metadata.tailscale_port);
  const healthUrl = opts.healthUrl ?? stringValue(server.metadata.health_url) ?? defaultHealthUrl(port);
  const logFile = resolve(
    opts.logFile
      ?? stringValue(server.metadata.log_file)
      ?? join(cwd, ".servers", `${server.slug}.log`),
  );

  return {
    command,
    cwd,
    port,
    healthUrl,
    env: { ...envValue(server.metadata.env), ...(opts.env ?? {}) },
    logFile,
    readyTimeoutMs: opts.readyTimeoutMs ?? numberValue(server.metadata.ready_timeout_ms) ?? DEFAULT_READY_TIMEOUT_MS,
    stopTimeoutMs: opts.stopTimeoutMs ?? numberValue(server.metadata.stop_timeout_ms) ?? DEFAULT_STOP_TIMEOUT_MS,
  };
}

function isProcessRunning(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sendProcessSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") throw error;
    if (code !== "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw inner;
      }
      return;
    }
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function checkHealthUrl(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkTcpPort(port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

export async function getLocalServerSnapshot(
  server: Server,
  options: { timeoutMs?: number } = {},
): Promise<LocalServerSnapshot> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const pid = numberValue(server.metadata.pid) ?? null;
  const port = numberValue(server.metadata.port) ?? numberValue(server.metadata.tailscale_port) ?? null;
  const healthUrl = stringValue(server.metadata.health_url) ?? defaultHealthUrl(port ?? undefined) ?? null;
  const running = isProcessRunning(pid);
  let ready = false;

  if (healthUrl) {
    ready = await checkHealthUrl(healthUrl, timeoutMs);
  } else if (port) {
    ready = await checkTcpPort(port, timeoutMs);
  } else {
    ready = running;
  }

  return {
    pid,
    running,
    ready,
    status: ready ? "online" : running ? server.status : "offline",
    command: stringValue(server.metadata.start_command) ?? stringValue(server.metadata.command) ?? null,
    cwd: stringValue(server.metadata.cwd) ?? server.path,
    port,
    healthUrl,
    logFile: stringValue(server.metadata.log_file) ?? null,
    checkedAt: now(),
    details: {},
  };
}

async function waitForReadiness(
  getServerSnapshot: () => Promise<LocalServerSnapshot>,
  timeoutMs: number,
  options: { spawnedPid?: number; logFile?: string } = {},
): Promise<LocalServerSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last = await getServerSnapshot();
  while (Date.now() < deadline) {
    if (last.ready) return last;
    if (options.spawnedPid && !isProcessRunning(options.spawnedPid)) {
      const logTail = options.logFile ? readLogTail(options.logFile) : null;
      const suffix = logTail?.trim()
        ? ` Last log output:\n${logTail.trim()}`
        : "";
      throw new Error(`Process ${options.spawnedPid} exited before server became ready.${suffix}`);
    }
    await sleep(DEFAULT_POLL_MS);
    last = await getServerSnapshot();
  }
  return last;
}

async function waitForStop(pid: number | null, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(DEFAULT_POLL_MS);
  }
  return !isProcessRunning(pid);
}

function markServerOfflineAfterRuntimeFailure(
  serverId: string,
  agentId: string | undefined,
  reason: string | undefined,
  db: Database,
): void {
  const latest = getServer(serverId, db);
  if (latest) {
    updateServer(serverId, {
      status: "offline",
      metadata: updateRuntimeMetadata(latest, {
        stopped_at: now(),
        stopped_by: agentId,
        last_reason: reason ?? null,
      }, ["pid", "started_at"]),
    }, db);
  }
}

async function cleanupSpawnedProcessAfterFailure(
  serverId: string,
  pid: number,
  agentId: string | undefined,
  reason: string | undefined,
  timeoutMs: number,
  db: Database,
): Promise<void> {
  if (isProcessRunning(pid)) {
    sendProcessSignal(pid, "SIGTERM");
    const stopped = await waitForStop(pid, timeoutMs);
    if (!stopped) {
      sendProcessSignal(pid, "SIGKILL");
      await waitForStop(pid, 2000);
    }
  }

  markServerOfflineAfterRuntimeFailure(serverId, agentId, reason, db);
}

async function acquireLifecycleLock(
  serverId: string,
  agentId: string,
  opts: LocalLifecycleOptions,
  db: Database,
): Promise<void> {
  const waitForLock = opts.waitForLock ?? false;
  const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (acquireLock("server-runtime", serverId, agentId, "exclusive", DEFAULT_LOCK_TTL_MS, db)) {
      return;
    }
    const lock = checkLock("server-runtime", serverId, db);
    if (!waitForLock || Date.now() >= deadline) {
      throw new Error(`Server ${serverId} is locked by ${lock?.agent_id ?? "another agent"}`);
    }
    await sleep(DEFAULT_POLL_MS);
  }
}

function spawnDetached(config: ResolvedLifecycleConfig): number {
  mkdirSync(dirname(config.logFile), { recursive: true });
  const out = openSync(config.logFile, "a");
  try {
    const child = spawn("bash", ["-lc", config.command], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    if (!child.pid) throw new Error("Failed to start process: missing PID");
    return child.pid;
  } finally {
    closeSync(out);
  }
}

function readLogTail(logFile: string, maxBytes = 4000): string | null {
  try {
    if (!existsSync(logFile)) return null;
    const content = readFileSync(logFile, "utf-8");
    return content.length > maxBytes ? content.slice(-maxBytes) : content;
  } catch {
    return null;
  }
}

function operationMetadata(
  opts: LocalLifecycleOptions,
  config?: Partial<ResolvedLifecycleConfig>,
): Record<string, unknown> {
  return {
    reason: opts.reason ?? null,
    command: config?.command,
    cwd: config?.cwd,
    port: config?.port,
    health_url: config?.healthUrl,
    requested_at: now(),
  };
}

function updateRuntimeMetadata(
  server: Server,
  patch: Record<string, unknown>,
  remove: string[] = [],
): Record<string, unknown> {
  const metadata = { ...server.metadata, ...patch };
  for (const key of remove) delete metadata[key];
  return metadata;
}

async function finishFailedOperation(
  operationId: string,
  server: Server,
  agentId: string | undefined,
  event: string,
  error: unknown,
  db: Database,
): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  failOperation(operationId, message, db);
  createTrace({
    server_id: server.id,
    operation_id: operationId,
    agent_id: agentId,
    event,
    details: { error: message },
  }, db);
  throw error;
}

export async function startLocalServer(
  idOrSlug: string,
  opts: LocalLifecycleOptions = {},
  db: Database = getDatabase(),
): Promise<LocalLifecycleResult> {
  const agentId = opts.agentId ?? "unknown-agent";
  const server = resolveServer(idOrSlug, db);
  const config = resolveLifecycleConfig(server, opts);
  let spawnedPid: number | undefined;
  const operation = createOperation({
    server_id: server.id,
    operation_type: "start",
    agent_id: agentId,
    session_id: opts.sessionId,
    metadata: operationMetadata(opts, config),
  }, db);

  try {
    await acquireLifecycleLock(server.id, agentId, opts, db);
    startOperation(operation.id, db);
    createTrace({
      server_id: server.id,
      operation_id: operation.id,
      agent_id: agentId,
      event: "server.start.requested",
      details: operation.metadata,
    }, db);

    const existingSnapshot = await getLocalServerSnapshot(server);
    if (existingSnapshot.ready && !opts.force) {
      const unchanged = updateServer(server.id, {
        status: "online",
        last_heartbeat: now(),
      }, db);
      const completed = completeOperation(operation.id, db);
      const snapshot = await getLocalServerSnapshot(unchanged);
      return { server: unchanged, operation: completed, snapshot, ready: snapshot.ready, pid: snapshot.pid ?? undefined };
    }

    const pid = spawnDetached(config);
    spawnedPid = pid;
    let updated = updateServer(server.id, {
      status: "starting",
      metadata: updateRuntimeMetadata(server, {
        start_command: config.command,
        cwd: config.cwd,
        port: config.port,
        health_url: config.healthUrl,
        env: config.env,
        pid,
        log_file: config.logFile,
        started_at: now(),
        started_by: agentId,
        last_reason: opts.reason ?? null,
      }),
    }, db);

    const wait = opts.wait ?? true;
    const snapshot = wait
      ? await waitForReadiness(
        () => getLocalServerSnapshot(getServer(server.id, db)!),
        config.readyTimeoutMs,
        { spawnedPid: pid, logFile: config.logFile },
      )
      : await getLocalServerSnapshot(updated);

    updated = updateServer(server.id, {
      status: snapshot.ready ? "online" : "starting",
      last_heartbeat: snapshot.ready ? now() : undefined,
    }, db);

    if (wait && !snapshot.ready) {
      throw new Error(`Server ${server.slug} did not become ready within ${config.readyTimeoutMs}ms`);
    }

    createTrace({
      server_id: server.id,
      operation_id: operation.id,
      agent_id: agentId,
      event: "server.started",
      details: { pid, ready: snapshot.ready, health_url: config.healthUrl, log_file: config.logFile },
    }, db);
    const completed = completeOperation(operation.id, db);
    return { server: updated, operation: completed, snapshot, pid, ready: snapshot.ready };
  } catch (error) {
    if (spawnedPid) {
      await cleanupSpawnedProcessAfterFailure(
        server.id,
        spawnedPid,
        agentId,
        opts.reason,
        config.stopTimeoutMs,
        db,
      );
    }
    return await finishFailedOperation(operation.id, server, agentId, "server.start.failed", error, db);
  } finally {
    releaseLock("server-runtime", server.id, agentId, db);
  }
}

export async function stopLocalServer(
  idOrSlug: string,
  opts: LocalLifecycleOptions = {},
  db: Database = getDatabase(),
): Promise<LocalLifecycleResult> {
  const agentId = opts.agentId ?? "unknown-agent";
  const server = resolveServer(idOrSlug, db);
  const operation = createOperation({
    server_id: server.id,
    operation_type: "stop",
    agent_id: agentId,
    session_id: opts.sessionId,
    metadata: operationMetadata(opts),
  }, db);

  try {
    await acquireLifecycleLock(server.id, agentId, opts, db);
    startOperation(operation.id, db);
    createTrace({
      server_id: server.id,
      operation_id: operation.id,
      agent_id: agentId,
      event: "server.stop.requested",
      details: operation.metadata,
    }, db);

    const pid = numberValue(server.metadata.pid) ?? null;
    let stopped = true;
    if (isProcessRunning(pid)) {
      sendProcessSignal(pid!, "SIGTERM");
      if (opts.wait === false) {
        const updated = updateServer(server.id, {
          status: "stopping",
          metadata: updateRuntimeMetadata(server, {
            stop_requested_at: now(),
            stopped_by: agentId,
            last_reason: opts.reason ?? null,
          }),
        }, db);
        const snapshot = await getLocalServerSnapshot(updated);
        createTrace({
          server_id: server.id,
          operation_id: operation.id,
          agent_id: agentId,
          event: "server.stop.signal_sent",
          details: { pid, wait: false },
        }, db);
        const completed = completeOperation(operation.id, db);
        return { server: updated, operation: completed, snapshot, ready: snapshot.ready, pid: pid ?? undefined };
      }

      stopped = await waitForStop(pid, opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
      if (!stopped && opts.force === true) {
        sendProcessSignal(pid!, "SIGKILL");
        stopped = await waitForStop(pid, 2000);
      }
    }

    if (!stopped) {
      throw new Error(`Server ${server.slug} process ${pid} did not stop within ${opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS}ms`);
    }

    const updated = updateServer(server.id, {
      status: "offline",
      metadata: updateRuntimeMetadata(server, {
        stopped_at: now(),
        stopped_by: agentId,
        last_reason: opts.reason ?? null,
      }, ["pid", "started_at"]),
    }, db);
    const snapshot = await getLocalServerSnapshot(updated);
    createTrace({
      server_id: server.id,
      operation_id: operation.id,
      agent_id: agentId,
      event: "server.stopped",
      details: { pid, stopped: true },
    }, db);
    const completed = completeOperation(operation.id, db);
    return { server: updated, operation: completed, snapshot, ready: snapshot.ready, pid: pid ?? undefined };
  } catch (error) {
    return await finishFailedOperation(operation.id, server, agentId, "server.stop.failed", error, db);
  } finally {
    releaseLock("server-runtime", server.id, agentId, db);
  }
}

export async function restartLocalServer(
  idOrSlug: string,
  opts: LocalLifecycleOptions = {},
  db: Database = getDatabase(),
): Promise<LocalLifecycleResult> {
  const agentId = opts.agentId ?? "unknown-agent";
  const server = resolveServer(idOrSlug, db);
  const config = resolveLifecycleConfig(server, opts);
  let newPid: number | undefined;
  let runtimeWasChanged = false;
  const operation = createOperation({
    server_id: server.id,
    operation_type: "restart" as OperationType,
    agent_id: agentId,
    session_id: opts.sessionId,
    metadata: operationMetadata(opts, config),
  }, db);

  try {
    await acquireLifecycleLock(server.id, agentId, opts, db);
    startOperation(operation.id, db);
    createTrace({
      server_id: server.id,
      operation_id: operation.id,
      agent_id: agentId,
      event: "server.restart.requested",
      details: operation.metadata,
    }, db);

    const pid = numberValue(server.metadata.pid) ?? null;
    if (isProcessRunning(pid)) {
      sendProcessSignal(pid!, "SIGTERM");
      const stopped = await waitForStop(pid, opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
      if (!stopped && opts.force === true) {
        sendProcessSignal(pid!, "SIGKILL");
        const killed = await waitForStop(pid, 2000);
        if (!killed) {
          throw new Error(`Server ${server.slug} process ${pid} did not stop after SIGKILL`);
        }
      } else if (!stopped) {
        throw new Error(`Server ${server.slug} process ${pid} did not stop within ${opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS}ms`);
      }
    }

    const intermediate = updateServer(server.id, {
      status: "restarting",
      metadata: updateRuntimeMetadata(server, {}, ["pid", "started_at"]),
    }, db);
    runtimeWasChanged = true;

    newPid = spawnDetached(config);
    let updated = updateServer(server.id, {
      status: "starting",
      metadata: updateRuntimeMetadata(intermediate, {
        start_command: config.command,
        cwd: config.cwd,
        port: config.port,
        health_url: config.healthUrl,
        env: config.env,
        pid: newPid,
        log_file: config.logFile,
        started_at: now(),
        started_by: agentId,
        last_reason: opts.reason ?? null,
      }),
    }, db);

    const snapshot = opts.wait === false
      ? await getLocalServerSnapshot(updated)
      : await waitForReadiness(
        () => getLocalServerSnapshot(getServer(server.id, db)!),
        config.readyTimeoutMs,
        { spawnedPid: newPid, logFile: config.logFile },
      );

    updated = updateServer(server.id, {
      status: snapshot.ready ? "online" : "starting",
      last_heartbeat: snapshot.ready ? now() : undefined,
    }, db);

    if (opts.wait !== false && !snapshot.ready) {
      throw new Error(`Server ${server.slug} did not become ready within ${config.readyTimeoutMs}ms`);
    }

    createTrace({
      server_id: server.id,
      operation_id: operation.id,
      agent_id: agentId,
      event: "server.restarted",
      details: { old_pid: pid, pid: newPid, ready: snapshot.ready },
    }, db);
    const completed = completeOperation(operation.id, db);
    return { server: updated, operation: completed, snapshot, pid: newPid, ready: snapshot.ready };
  } catch (error) {
    if (newPid) {
      await cleanupSpawnedProcessAfterFailure(
        server.id,
        newPid,
        agentId,
        opts.reason,
        config.stopTimeoutMs,
        db,
      );
    } else if (runtimeWasChanged) {
      markServerOfflineAfterRuntimeFailure(server.id, agentId, opts.reason, db);
    }
    return await finishFailedOperation(operation.id, server, agentId, "server.restart.failed", error, db);
  } finally {
    releaseLock("server-runtime", server.id, agentId, db);
  }
}

export function displayNameForServerConfig(cwd: string): string {
  return basename(resolve(cwd)) || "app-server";
}
