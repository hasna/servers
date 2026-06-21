import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const cleanupDirs: string[] = [];

setDefaultTimeout(10_000);

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createHttpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function runCli(args: string[], options: { cwd?: string; dbPath?: string } = {}) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...(options.dbPath ? ["--db", options.dbPath] : []), ...args], {
    cwd: options.cwd ?? repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("servers lifecycle CLI", () => {
  it("initializes, starts, reports, debugs, logs, and stops a local app server", async () => {
    const appDir = makeTempDir("servers-cli-app-");
    const dbPath = join(makeTempDir("servers-cli-db-"), "servers.db");
    const port = await getFreePort();
    let pid: number | undefined;

    writeFileSync(
      join(appDir, "server.js"),
      `
const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    );

    const init = await runCli([
      "servers:init",
      "--name",
      "cli-app",
      "--path",
      appDir,
      "--command",
      "bun run server.js",
      "--port",
      String(port),
      "--env",
      `PORT=${port}`,
      "--json",
    ], { dbPath });
    expect(init.exitCode).toBe(0);
    const initJson = JSON.parse(init.stdout);
    expect(initJson.server.slug).toBe("cli-app");
    expect(initJson.command).toBe("bun run server.js");

    try {
      const start = await runCli([
        "servers:start",
        "cli-app",
        "--agent",
        "cli-test-agent",
        "--reason",
        "cli regression",
        "--timeout",
        "8000",
        "--json",
      ], { dbPath });
      expect(start.exitCode).toBe(0);
      const startJson = JSON.parse(start.stdout);
      pid = startJson.pid;
      expect(startJson.ready).toBe(true);
      expect(startJson.server.status).toBe("online");

      const status = await runCli(["servers:status", "cli-app", "--refresh", "--json"], { dbPath });
      expect(status.exitCode).toBe(0);
      const statusJson = JSON.parse(status.stdout);
      expect(statusJson.snapshot.ready).toBe(true);

      const debug = await runCli(["servers:debug", "cli-app", "--json"], { dbPath });
      expect(debug.exitCode).toBe(0);
      const debugJson = JSON.parse(debug.stdout);
      expect(debugJson.operations.some((op: { operation_type: string }) => op.operation_type === "start")).toBe(true);

      const logs = await runCli(["servers:logs", "cli-app", "--lines", "20"], { dbPath });
      expect(logs.exitCode).toBe(0);
      expect(logs.stdout).toContain("ready");

      const stop = await runCli(["servers:stop", "cli-app", "--agent", "cli-test-agent", "--timeout", "8000", "--json"], { dbPath });
      expect(stop.exitCode).toBe(0);
      const stopJson = JSON.parse(stop.stdout);
      pid = undefined;
      expect(stopJson.server.status).toBe("offline");
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  });
});
