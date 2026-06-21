import { describe, expect, test } from "bun:test";
import { exec } from "child_process";
import { promisify } from "util";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execAsync = promisify(exec);
const CLI = "bun run src/cli/index.ts";
const VERSION = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;

function withTmpDb(): { dbFlag: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "servers-test-"));
  const dbPath = join(dir, "test.db");
  return {
    dbFlag: `--db ${dbPath}`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function run(cmd: string) {
  const { stdout, stderr } = await execAsync(cmd, { env: { ...process.env } });
  return { stdout, stderr };
}

async function runExpectFailure(cmd: string, opts: { timeoutMs?: number } = {}) {
  try {
    await execAsync(cmd, { env: { ...process.env }, timeout: opts.timeoutMs });
  } catch (error: any) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      code: error.code,
    };
  }
  throw new Error(`Command unexpectedly succeeded: ${cmd}`);
}

describe("CLI integration tests", () => {

  test("version reports package version", async () => {
    const { stdout } = await run(`${CLI} --version`);
    expect(stdout.trim()).toBe(VERSION);
  });

  test("help exposes shared events commands without replacing native webhooks", async () => {
    const eventsDir = mkdtempSync(join(tmpdir(), "servers-events-"));
    try {
      const { stdout } = await execAsync(`${CLI} --help`, { env: { ...process.env, HASNA_EVENTS_DIR: eventsDir } });

      expect(stdout).toContain("events");
      expect(stdout).toContain("event-webhooks");
      expect(stdout).toContain("webhooks");
    } finally {
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });

  test("dashboard shows without errors", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      const { stdout } = await run(`${CLI} ${dbFlag}`);
      expect(stdout).toContain("Server Status");
      expect(stdout).toContain("Agents");
      expect(stdout).toContain("Operations");
    } finally {
      cleanup();
    }
  });

  test("server lifecycle: add, get, update, delete", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      const { stdout: added } = await run(`${CLI} ${dbFlag} server:add -n "Test Server" --slug test-srv --hostname 10.0.0.1`);
      expect(added).toContain("Created server");

      const { stdout: listed } = await run(`${CLI} ${dbFlag} server`);
      expect(listed).toContain("Test Server");

      const { stdout: updated } = await run(`${CLI} ${dbFlag} server:update test-srv --status online`);
      expect(updated).toContain("Updated server");

      const { stdout: got } = await run(`${CLI} ${dbFlag} server:get test-srv`);
      expect(got).toContain("online");

      const { stdout: deleted } = await run(`${CLI} ${dbFlag} server:delete test-srv`);
      expect(deleted).toContain("Deleted server");
    } finally {
      cleanup();
    }
  });

  test("servers command is the primary list command and server remains an alias", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      await run(`${CLI} ${dbFlag} servers:add -n "Plural Server" --slug plural`);

      const { stdout: plural } = await run(`${CLI} ${dbFlag} servers`);
      expect(plural).toContain("Plural Server");
      expect(plural).toContain("TAILSCALE URL");

      const { stdout: singular } = await run(`${CLI} ${dbFlag} server`);
      expect(singular).toContain("Plural Server");
    } finally {
      cleanup();
    }
  });

  test("server CLI exposes Tailscale URL metadata in list and get output", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    const previousTailnet = process.env.TAILSCALE_TAILNET;
    process.env.TAILSCALE_TAILNET = "example-tailnet";

    try {
      await run(`${CLI} ${dbFlag} servers:add -n "Tail Server" --slug tail --hostname spark01 --tailscale-hostname spark01 --tailscale-port 7010`);

      const { stdout: listed } = await run(`${CLI} ${dbFlag} servers`);
      expect(listed).toContain("https://spark01.example-tailnet.ts.net:7010");

      const { stdout: got } = await run(`${CLI} ${dbFlag} servers:get tail`);
      expect(got).toContain("Tailscale:");
      expect(got).toContain("https://spark01.example-tailnet.ts.net:7010");

      const { stdout: json } = await run(`${CLI} ${dbFlag} servers:get tail --json`);
      const parsed = JSON.parse(json);
      expect(parsed.metadata.tailscale_hostname).toBe("spark01");
      expect(parsed.metadata.tailscale_port).toBe(7010);
      expect(parsed.tailscale_url).toBe("https://spark01.example-tailnet.ts.net:7010");
    } finally {
      if (previousTailnet === undefined) {
        delete process.env.TAILSCALE_TAILNET;
      } else {
        process.env.TAILSCALE_TAILNET = previousTailnet;
      }
      cleanup();
    }
  });

  test("server JSON output redacts camelCase secret metadata keys", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    const privateKey = "private-key-sentinel-value";
    const clientSecret = "client-secret-sentinel-value";
    const sessionCookie = "session-cookie-sentinel-value";
    const metadata = JSON.stringify({
      privateKey,
      oauth: {
        clientSecret,
        sessionCookie,
      },
      harmless: "visible-value",
    });

    try {
      await run(`${CLI} ${dbFlag} servers:add -n "Secret Server" --slug secret-server --metadata '${metadata}'`);

      const { stdout } = await run(`${CLI} ${dbFlag} servers:get secret-server --json`);
      const parsed = JSON.parse(stdout);

      expect(stdout).not.toContain(privateKey);
      expect(stdout).not.toContain(clientSecret);
      expect(stdout).not.toContain(sessionCookie);
      expect(parsed.metadata.privateKey).toBe("[redacted]");
      expect(parsed.metadata.oauth.clientSecret).toBe("[redacted]");
      expect(parsed.metadata.oauth.sessionCookie).toBe("[redacted]");
      expect(parsed.metadata.harmless).toBe("visible-value");
    } finally {
      cleanup();
    }
  });

  test("server CLI rejects malformed numeric options", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    const appDir = mkdtempSync(join(tmpdir(), "servers-init-app-"));
    try {
      const tailscalePort = await runExpectFailure(`${CLI} ${dbFlag} servers:add -n "Bad Port" --tailscale-port 7010abc`);
      expect(tailscalePort.code).not.toBe(0);
      expect(tailscalePort.stderr).toContain("--tailscale-port must be an integer from 1 to 65535");

      const lifecyclePort = await runExpectFailure(`${CLI} ${dbFlag} servers:init --name bad-init --path ${appDir} --command "bun run dev" --port 3000ms`);
      expect(lifecyclePort.code).not.toBe(0);
      expect(lifecyclePort.stderr).toContain("--port must be an integer");

      const operationsLimit = await runExpectFailure(`${CLI} ${dbFlag} operations --limit -1`);
      expect(operationsLimit.code).not.toBe(0);
      expect(operationsLimit.stderr).toContain("--limit must be an integer greater than or equal to 1");

      const monitorInterval = await runExpectFailure(`${CLI} ${dbFlag} monitor --interval 0`, { timeoutMs: 1000 });
      expect(monitorInterval.code).not.toBe(0);
      expect(monitorInterval.stderr).toContain("--interval must be an integer greater than or equal to 1");
    } finally {
      rmSync(appDir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("agent lifecycle: register, update, heartbeat", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      const { stdout: reg } = await run(`${CLI} ${dbFlag} agent:register -n "TestAgent"`);
      expect(reg).toContain("Registered");

      const { stdout: updated } = await run(`${CLI} ${dbFlag} agent:update TestAgent --description "Updated desc" --capabilities docs,review`);
      expect(updated).toContain("Updated agent");

      const exportFile = join(tmpdir(), `servers-agent-export-${Date.now()}.json`);
      await run(`${CLI} ${dbFlag} export --output ${exportFile}`);
      const exported = JSON.parse(readFileSync(exportFile, "utf8"));
      const agent = exported.agents.find((a: any) => a.name === "TestAgent");
      expect(agent.description).toBe("Updated desc");
      expect(agent.capabilities).toEqual(["docs", "review"]);

      const { stdout: hb } = await run(`${CLI} ${dbFlag} agent:heartbeat TestAgent`);
      expect(hb).toContain("Heartbeat");
    } finally {
      cleanup();
    }
  });

  test("operation lifecycle: add, start, complete", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      await run(`${CLI} ${dbFlag} server:add -n "Ops Server" --slug ops`);

      await run(`${CLI} ${dbFlag} operation:add --server ops --type deploy`);
      // Get the full operation ID from JSON output
      const { stdout: opsJson } = await run(`${CLI} ${dbFlag} operations --json`);
      const ops = JSON.parse(opsJson);
      expect(ops.length).toBeGreaterThan(0);
      const opId = ops[0].id;

      const { stdout: started } = await run(`${CLI} ${dbFlag} operation:start ${opId}`);
      expect(started).toContain("running");

      const { stdout: completed } = await run(`${CLI} ${dbFlag} operation:complete ${opId}`);
      expect(completed).toContain("Completed");
    } finally {
      cleanup();
    }
  });

  test("trace: add and list", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      await run(`${CLI} ${dbFlag} server:add -n "Trace Server" --slug trace`);
      const { stdout } = await run(`${CLI} ${dbFlag} trace:add --server trace --event "test.event"`);
      expect(stdout).toContain("Trace created");

      const { stdout: listed } = await run(`${CLI} ${dbFlag} traces`);
      expect(listed).toContain("test.event");
    } finally {
      cleanup();
    }
  });

  test("export and import round-trip", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    const { dbFlag: dbFlag2, cleanup: cleanup2 } = withTmpDb();
    try {
      await run(`${CLI} ${dbFlag} server:add -n "Export Server" --slug exp --hostname 1.2.3.4`);
      await run(`${CLI} ${dbFlag} agent:register -n "ExpAgent" --description "for export"`);

      const exportFile = join(tmpdir(), `servers-export-${Date.now()}.json`);
      const { stdout } = await run(`${CLI} ${dbFlag} export --output ${exportFile}`);
      expect(stdout).toContain("Exported to");

      const { stdout: imported } = await run(`${CLI} ${dbFlag2} import --input ${exportFile}`);
      expect(imported).toContain("Imported");
      expect(imported).toContain("servers:");

      const { stdout: listed } = await run(`${CLI} ${dbFlag2} server`);
      expect(listed).toContain("Export Server");
    } finally {
      cleanup();
      cleanup2();
    }
  });

  test("webhook: add and list", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      const { stdout: added } = await run(`${CLI} ${dbFlag} webhook:add --url https://example.com/hook --events server.created`);
      expect(added).toContain("Created webhook");

      const { stdout: listed } = await run(`${CLI} ${dbFlag} webhooks`);
      expect(listed).toContain("example.com");
    } finally {
      cleanup();
    }
  });

  test("webhook logs command uses plural naming and keeps delivery alias", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      await run(`${CLI} ${dbFlag} webhook:add --url https://example.com/hook --events server.created`);

      const { stdout: logs } = await run(`${CLI} ${dbFlag} webhooks:logs`);
      expect(logs).toContain("WEBHOOK");

      const { stdout: oldAlias } = await run(`${CLI} ${dbFlag} webhook:deliveries`);
      expect(oldAlias).toContain("WEBHOOK");
    } finally {
      cleanup();
    }
  });

  test("JSON output format", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      await run(`${CLI} ${dbFlag} server:add -n "JSON Server" --slug json`);
      const { stdout } = await run(`${CLI} ${dbFlag} server --json`);
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.some((s: any) => s.name === "JSON Server")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("global --format json is honored by servers:get", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      await run(`${CLI} ${dbFlag} server:add -n "Fmt Get Server" --slug fmt-get --hostname 9.9.9.9`);
      const { stdout } = await run(`${CLI} --format json ${dbFlag} servers:get fmt-get`);
      const parsed = JSON.parse(stdout);
      expect(parsed.name).toBe("Fmt Get Server");
      expect(parsed.slug).toBe("fmt-get");
    } finally {
      cleanup();
    }
  });

  test("global --format json is honored by every read subcommand", async () => {
    const { dbFlag, cleanup } = withTmpDb();
    try {
      await run(`${CLI} ${dbFlag} server:add -n "Fmt All Server" --slug fmt-all`);
      await run(`${CLI} ${dbFlag} agent:register -n "FmtAgent"`);
      await run(`${CLI} ${dbFlag} operation:add --server fmt-all --type deploy`);
      await run(`${CLI} ${dbFlag} trace:add --server fmt-all --event "fmt.event"`);
      await run(`${CLI} ${dbFlag} project:add -n "FmtProject" --path /tmp/fmt-project-path`);
      await run(`${CLI} ${dbFlag} webhook:add --url https://example.com/fmt --events server.created`);

      // Each of these must emit parseable JSON when the GLOBAL --format json flag is set,
      // exactly like the per-command --json flag does.
      const cases: { cmd: string; assert: (parsed: any) => void }[] = [
        { cmd: `servers`, assert: (p) => expect(Array.isArray(p)).toBe(true) },
        { cmd: `servers:get fmt-all`, assert: (p) => expect(p.slug).toBe("fmt-all") },
        { cmd: `agents`, assert: (p) => expect(Array.isArray(p)).toBe(true) },
        { cmd: `operations`, assert: (p) => expect(Array.isArray(p)).toBe(true) },
        { cmd: `traces`, assert: (p) => expect(Array.isArray(p)).toBe(true) },
        { cmd: `projects`, assert: (p) => expect(Array.isArray(p)).toBe(true) },
        { cmd: `webhooks`, assert: (p) => expect(Array.isArray(p)).toBe(true) },
        { cmd: `webhooks:logs`, assert: (p) => expect(Array.isArray(p)).toBe(true) },
        { cmd: `servers:status fmt-all`, assert: (p) => expect(p.server.slug).toBe("fmt-all") },
        { cmd: `servers:debug fmt-all`, assert: (p) => expect(p.server.slug).toBe("fmt-all") },
      ];

      for (const { cmd, assert } of cases) {
        const { stdout } = await run(`${CLI} --format json ${dbFlag} ${cmd}`);
        let parsed: any;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw new Error(`--format json was ignored by: ${cmd}\nOutput was:\n${stdout}`);
        }
        assert(parsed);
      }
    } finally {
      cleanup();
    }
  });

  test("completion generates for all shells", async () => {
    const shells = ["bash", "zsh", "fish"];
    for (const shell of shells) {
      const { stdout } = await run(`${CLI} completion ${shell}`);
      expect(stdout.length).toBeGreaterThan(10);
      expect(stdout).toContain("server");
      expect(stdout).toContain("servers:add");
      expect(stdout).toContain("server:add");
      expect(stdout).toContain("webhooks:logs");
      expect(stdout).toContain("webhook:deliveries");
    }
  });
});
