import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import {
  getStorageDatabaseEnv,
  getStorageDatabaseUrl,
  getStorageMode,
  getStorageStatus,
  parseStorageTables,
  resolveTables,
  STORAGE_TABLES,
} from "./storage-sync.js";

const envKeys = [
  "HASNA_SERVERS_DATABASE_URL",
  "SERVERS_DATABASE_URL",
  "HASNA_SERVERS_STORAGE_MODE",
  "SERVERS_STORAGE_MODE",
  "SERVERS_DB_PATH",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of envKeys) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env["SERVERS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("servers storage sync config", () => {
  test("canonical storage database env wins over fallback env", () => {
    process.env["HASNA_SERVERS_DATABASE_URL"] = "postgres://new.example/servers";
    process.env["SERVERS_DATABASE_URL"] = "postgres://fallback.example/servers";

    expect(getStorageDatabaseUrl()).toBe("postgres://new.example/servers");
    expect(getStorageDatabaseEnv()).toEqual({ name: "HASNA_SERVERS_DATABASE_URL" });
    expect(getStorageMode()).toBe("hybrid");
  });

  test("fallback storage database env is accepted", () => {
    process.env["SERVERS_DATABASE_URL"] = "postgres://fallback.example/servers";

    expect(getStorageDatabaseUrl()).toBe("postgres://fallback.example/servers");
    expect(getStorageDatabaseEnv()).toEqual({ name: "SERVERS_DATABASE_URL" });
    expect(getStorageMode()).toBe("hybrid");
  });

  test("canonical storage mode wins over fallback mode", () => {
    process.env["HASNA_SERVERS_STORAGE_MODE"] = "remote";
    process.env["SERVERS_STORAGE_MODE"] = "hybrid";

    expect(getStorageMode()).toBe("remote");
  });

  test("resolves storage tables", () => {
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(resolveTables(["servers", "server_operations"])).toEqual(["servers", "server_operations"]);
    expect(parseStorageTables("servers, server_operations")).toEqual(["servers", "server_operations"]);
    expect(() => resolveTables(["missing"])).toThrow("Unknown servers sync table");
  });

  test("status reports local mode and sync table state", () => {
    const status = getStorageStatus();

    expect(status.configured).toBe(false);
    expect(status.mode).toBe("local");
    expect(status.activeEnv).toBe(null);
    expect(status.service).toBe("servers");
    expect(status.tables).toContain("servers");
    expect(status.sync).toEqual([]);
  });
});
