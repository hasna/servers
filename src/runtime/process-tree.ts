import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Cross-platform (Linux + macOS) process-tree utilities used by the local
 * server lifecycle. The recorded PID alone is not enough to reliably stop a
 * dev server: tools like `bunx next dev` spawn worker processes that detach
 * into their own process group / session, so killing the recorded PID's group
 * leaves the real server running while the wrapper exits. These helpers find
 * the *actual* live processes belonging to a server — by descendant tree, by
 * the port it listens on, and by command + working directory — and take the
 * whole tree down, escalating SIGTERM -> SIGKILL, then verify nothing survived.
 */

export interface KillTreeOptions {
  /** The recorded root PID (group leader) of the server, if known. */
  pid?: number | null;
  /** The TCP port the server listens on, used to find escaped listeners. */
  port?: number | null;
  /** The configured start command, used to match reparented processes. */
  command?: string | null;
  /** The configured working directory, used to disambiguate command matches. */
  cwd?: string | null;
  /** How long to wait after SIGTERM before escalating to SIGKILL. */
  gracePeriodMs?: number;
  /** Poll interval while waiting for processes to exit. */
  pollMs?: number;
  /** When false, never escalate to SIGKILL (SIGTERM only). Default true. */
  escalate?: boolean;
}

export interface KillTreeResult {
  /** True when no targeted process is alive and the port is free. */
  stopped: boolean;
  /** PIDs that were signalled. */
  targeted: number[];
  /** PIDs still alive after the attempt (empty when stopped). */
  survivors: number[];
  /** True when the port is still held by a listener after the attempt. */
  portStillListening: boolean;
}

const DEFAULT_GRACE_MS = 8000;
const DEFAULT_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isZombie(pid: number): boolean {
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 1000,
    }).trim();
    return stat.startsWith("Z");
  } catch {
    return false;
  }
}

function groupHasLiveMember(pgid: number): boolean {
  try {
    const out = execFileSync("ps", ["-eo", "pgid=,stat="], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 1000,
    });
    let sawGroup = false;
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(\S+)/);
      if (!m) continue;
      const processGroup = Number.parseInt(m[1]!, 10);
      if (processGroup !== pgid) continue;
      sawGroup = true;
      if (!m[2]!.startsWith("Z")) return true;
    }
    return sawGroup ? false : true;
  } catch {
    return true;
  }
}

/** Liveness check for a single PID (not the group). EPERM counts as alive. */
export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return !isZombie(pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Liveness check for a process group (negative PID). EPERM counts as alive. */
export function isGroupAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return groupHasLiveMember(pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runQuietly(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch (error) {
    // lsof/ps exit non-zero when they find nothing; surface their captured stdout.
    const out = (error as { stdout?: string | Buffer })?.stdout;
    if (out == null) return "";
    return typeof out === "string" ? out : out.toString("utf-8");
  }
}

function parsePids(raw: string): number[] {
  const pids = new Set<number>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pid = Number.parseInt(trimmed, 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

/** Find PIDs currently LISTENing on a TCP port (IPv4/IPv6), via lsof. */
export function findListenerPids(port: number | null | undefined): number[] {
  if (!port || !Number.isInteger(port) || port < 1) return [];
  // -t: terse (pids only), -sTCP:LISTEN: only listeners, -nP: no name/port resolution.
  const out = runQuietly("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return parsePids(out);
}

interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}

function listProcesses(): ProcInfo[] {
  // Portable across Linux and macOS. `=` headers suppress the column titles.
  const out = runQuietly("ps", ["-eo", "pid=,ppid=,args="]);
  const procs: ProcInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1]!, 10);
    const ppid = Number.parseInt(m[2]!, 10);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    procs.push({ pid, ppid, command: m[3] ?? "" });
  }
  return procs;
}

/** Collect a PID and all of its descendants from a ps snapshot. */
function collectDescendants(rootPid: number, procs: ProcInfo[]): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) {
    const list = childrenOf.get(p.ppid) ?? [];
    list.push(p.pid);
    childrenOf.set(p.ppid, list);
  }
  const result = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    if (result.has(pid)) continue;
    result.add(pid);
    for (const child of childrenOf.get(pid) ?? []) stack.push(child);
  }
  result.delete(process.pid);
  return [...result];
}

/** Best-effort cwd of a PID, portable across Linux (/proc) and macOS (lsof). */
function cwdOf(pid: number): string | null {
  try {
    const link = readlinkSync(`/proc/${pid}/cwd`);
    if (link) return resolve(link);
  } catch {
    // not Linux or process gone — fall through to lsof
  }
  const out = runQuietly("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("n")) {
      const path = line.slice(1).trim();
      if (path) return resolve(path);
    }
  }
  return null;
}

/** Significant tokens of a start command, ignoring shell noise and run wrappers. */
function commandTokens(command: string): string[] {
  const ignore = new Set([
    "exec", "bash", "-lc", "-c", "sh", "env", "run", "bun", "bunx",
    "npm", "pnpm", "yarn", "npx", "node", "&&", "||",
  ]);
  return command
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !t.startsWith("-") && !ignore.has(t));
}

/**
 * Find processes whose command line matches the server's start command and
 * whose working directory matches the server's cwd. This catches workers that
 * reparented to init after the wrapper exited (so the ppid tree is broken) but
 * are unmistakably the same server by command + cwd.
 */
function findByCommandAndCwd(
  command: string | null | undefined,
  cwd: string | null | undefined,
  procs: ProcInfo[],
): number[] {
  if (!command) return [];
  const tokens = commandTokens(command);
  if (tokens.length === 0) return [];
  const wantCwd = cwd ? resolve(cwd) : null;
  const matches: number[] = [];
  for (const proc of procs) {
    const hasAll = tokens.every((tok) => proc.command.includes(tok));
    if (!hasAll) continue;
    if (wantCwd) {
      const procCwd = cwdOf(proc.pid);
      if (procCwd !== wantCwd) continue;
    }
    matches.push(proc.pid);
  }
  return matches;
}

/**
 * Discover every PID belonging to a server: its recorded PID, the whole
 * descendant tree, anything still LISTENing on its port, and any
 * command+cwd-matching survivor that reparented away.
 */
export function discoverServerPids(opts: {
  pid?: number | null;
  port?: number | null;
  command?: string | null;
  cwd?: string | null;
}): number[] {
  const procs = listProcesses();
  const pids = new Set<number>();

  if (opts.pid && isAlive(opts.pid)) {
    for (const descendant of collectDescendants(opts.pid, procs)) {
      if (isAlive(descendant)) pids.add(descendant);
    }
    if (isAlive(opts.pid)) pids.add(opts.pid);
  }

  for (const listener of findListenerPids(opts.port)) {
    if (isAlive(listener)) pids.add(listener);
  }

  for (const matched of findByCommandAndCwd(opts.command, opts.cwd, procs)) {
    if (isAlive(matched)) pids.add(matched);
  }

  pids.delete(process.pid);
  return [...pids];
}

function signal(pid: number, sig: NodeJS.Signals, group: boolean): void {
  try {
    process.kill(group ? -pid : pid, sig);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") throw error;
    // ESRCH (already gone) is fine.
  }
}

/**
 * Stop the whole process tree for a server and verify it is gone.
 *
 * 1. Discover all targets (recorded PID + descendants + port listeners + command/cwd matches).
 * 2. SIGTERM the recorded process group and each target.
 * 3. Wait the grace period for a clean exit.
 * 4. Escalate to SIGKILL (group + per-PID) unless escalation is disabled.
 * 5. Re-discover and verify nothing survives and the port is free.
 */
export async function killTree(opts: KillTreeOptions): Promise<KillTreeResult> {
  const grace = opts.gracePeriodMs ?? DEFAULT_GRACE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const escalate = opts.escalate ?? true;

  const initialTargets = discoverServerPids(opts);

  const sendToAll = (sig: NodeJS.Signals) => {
    // Signal the recorded group leader's whole group first (cheap, catches same-group children).
    if (opts.pid && isGroupAlive(opts.pid)) signal(opts.pid, sig, true);
    for (const pid of discoverServerPids(opts)) signal(pid, sig, false);
  };

  if (initialTargets.length === 0 && !findListenerPids(opts.port).length) {
    return { stopped: true, targeted: [], survivors: [], portStillListening: false };
  }

  // Graceful termination.
  sendToAll("SIGTERM");

  const deadline = Date.now() + grace;
  while (Date.now() < deadline) {
    if (discoverServerPids(opts).length === 0 && findListenerPids(opts.port).length === 0) {
      return { stopped: true, targeted: initialTargets, survivors: [], portStillListening: false };
    }
    await sleep(pollMs);
  }

  if (escalate) {
    // Forceful termination.
    sendToAll("SIGKILL");
    const killDeadline = Date.now() + Math.max(2000, Math.floor(grace / 2));
    while (Date.now() < killDeadline) {
      if (discoverServerPids(opts).length === 0 && findListenerPids(opts.port).length === 0) {
        return { stopped: true, targeted: initialTargets, survivors: [], portStillListening: false };
      }
      await sleep(pollMs);
    }
  }

  const survivors = discoverServerPids(opts);
  const portStillListening = findListenerPids(opts.port).length > 0;
  return {
    stopped: survivors.length === 0 && !portStillListening,
    targeted: initialTargets,
    survivors,
    portStillListening,
  };
}
