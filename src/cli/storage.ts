import type { Command } from "commander";
import { closeDatabase } from "../db/database.js";
import {
  getStorageStatus,
  parseStorageTables,
  storagePull,
  storagePush,
  storageSync,
  type SyncResult,
} from "../db/storage-sync.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printResults(results: SyncResult[], label: string): void {
  const total = results.reduce((sum, result) => sum + result.rowsWritten, 0);
  for (const result of results) {
    const errors = result.errors.length > 0 ? ` (${result.errors.join("; ")})` : "";
    console.log(`  ${result.table}: ${result.rowsWritten}/${result.rowsRead} rows ${label}${errors}`);
  }
  console.log(`Done. ${total} rows ${label}.`);
}

function shouldPrintJson(opts: { json?: boolean }, cmd: Command): boolean {
  const globals = cmd.optsWithGlobals() as { format?: string };
  return Boolean(opts.json || globals.format === "json");
}

export function registerStorageCommands(program: Command): void {
  const storageCmd = program.command("storage").description("Storage sync commands");

  storageCmd
    .command("status")
    .description("Show storage config and local sync state")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }, cmd) => {
      try {
        const info = getStorageStatus();
        if (shouldPrintJson(opts, cmd)) {
          printJson(info);
          return;
        }
        console.log(`Storage configured: ${info.configured ? "yes" : "no"}`);
        console.log(`Mode: ${info.mode}`);
        console.log(`Tables: ${info.tables.join(", ")}`);
        if (info.sync.length === 0) console.log("Sync: no local sync history");
        for (const entry of info.sync) {
          console.log(`  ${entry.table_name} ${entry.direction}: ${entry.last_synced_at ?? "never"}`);
        }
      } finally {
        closeDatabase();
      }
    });

  storageCmd
    .command("push")
    .description("Push local servers data to storage PostgreSQL")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .option("--json", "Output as JSON")
    .action(async (opts: { tables?: string; json?: boolean }, cmd) => {
      try {
        const results = await storagePush({ tables: parseStorageTables(opts.tables) });
        if (shouldPrintJson(opts, cmd)) {
          printJson(results);
          return;
        }
        printResults(results, "pushed");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      } finally {
        closeDatabase();
      }
    });

  storageCmd
    .command("pull")
    .description("Pull servers data from storage PostgreSQL to local SQLite")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .option("--json", "Output as JSON")
    .action(async (opts: { tables?: string; json?: boolean }, cmd) => {
      try {
        const results = await storagePull({ tables: parseStorageTables(opts.tables) });
        if (shouldPrintJson(opts, cmd)) {
          printJson(results);
          return;
        }
        printResults(results, "pulled");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      } finally {
        closeDatabase();
      }
    });

  storageCmd
    .command("sync")
    .description("Bidirectional sync: pull then push")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .option("--json", "Output as JSON")
    .action(async (opts: { tables?: string; json?: boolean }, cmd) => {
      try {
        const result = await storageSync({ tables: parseStorageTables(opts.tables) });
        if (shouldPrintJson(opts, cmd)) {
          printJson(result);
          return;
        }
        printResults(result.pull, "pulled");
        printResults(result.push, "pushed");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      } finally {
        closeDatabase();
      }
    });
}
