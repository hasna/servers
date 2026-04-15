import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runMigrations } from "./schema.js";

export const LOCK_EXPIRY_MINUTES = 30;

function isInMemoryDb(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

function findNearestServersDb(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".servers", "servers.db");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function getDbPath(): string {
  // 1. Environment variable override
  if (process.env["SERVERS_DB_PATH"]) {
    return process.env["SERVERS_DB_PATH"];
  }

  // 2. Per-project: .servers/servers.db in cwd or any parent
  const cwd = process.cwd();
  const nearest = findNearestServersDb(cwd);
  if (nearest) return nearest;

  // 3. Explicit project scope
  if (process.env["SERVERS_DB_SCOPE"] === "project") {
    const gitRoot = findGitRoot(cwd);
    if (gitRoot) {
      return join(gitRoot, ".servers", "servers.db");
    }
  }

  // 4. Default: ~/.hasna/servers/servers.db
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  return join(home, ".hasna", "servers", "servers.db");
}

function ensureDir(filePath: string): void {
  if (isInMemoryDb(filePath)) return;
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

let _db: Database | null = null;

export function getDatabase(dbPath?: string): Database {
  if (_db) return _db;

  const path = dbPath || getDbPath();
  ensureDir(path);

  _db = new Database(path);
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 5000");
  _db.run("PRAGMA foreign_keys = ON");

  runMigrations(_db);

  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function resetDatabase(): void {
  _db = null;
}

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function isLockExpired(lockedAt: string | null): boolean {
  if (!lockedAt) return true;
  const lockTime = new Date(lockedAt).getTime();
  const expiryMs = LOCK_EXPIRY_MINUTES * 60 * 1000;
  return Date.now() - lockTime > expiryMs;
}

export function lockExpiryCutoff(nowMs = Date.now()): string {
  const expiryMs = LOCK_EXPIRY_MINUTES * 60 * 1000;
  return new Date(nowMs - expiryMs).toISOString();
}

export function clearExpiredLocks(db: Database): void {
  const cutoff = lockExpiryCutoff();
  db.run(
    "UPDATE servers SET locked_by = NULL, locked_at = NULL WHERE locked_at IS NOT NULL AND locked_at < ?",
    [cutoff],
  );
}

export function resolvePartialId(
  db: Database,
  table: string,
  partialId: string,
): string | null {
  if (partialId.length >= 36) {
    const row = db
      .query(`SELECT id FROM ${table} WHERE id = ?`)
      .get(partialId) as { id: string } | null;
    return row?.id ?? null;
  }

  const rows = db
    .query(`SELECT id FROM ${table} WHERE id LIKE ?`)
    .all(`${partialId}%`) as { id: string }[];
  if (rows.length === 1) return rows[0]!.id;
  if (rows.length > 1) return null;

  // For servers, also try matching on name or slug
  if (table === "servers") {
    const nameRow = db
      .query("SELECT id FROM servers WHERE LOWER(name) = ?")
      .get(partialId.toLowerCase()) as { id: string } | null;
    if (nameRow) return nameRow.id;

    const slugRow = db
      .query("SELECT id FROM servers WHERE LOWER(slug) = ?")
      .get(partialId.toLowerCase()) as { id: string } | null;
    if (slugRow) return slugRow.id;
  }

  return null;
}
