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

describe("CLI integration tests", () => {

  test("version reports package version", async () => {
    const { stdout } = await run(`${CLI} --version`);
    expect(stdout.trim()).toBe(VERSION);
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

  test("completion generates for all shells", async () => {
    const shells = ["bash", "zsh", "fish"];
    for (const shell of shells) {
      const { stdout } = await run(`${CLI} completion ${shell}`);
      expect(stdout.length).toBeGreaterThan(10);
      expect(stdout).toContain("server");
    }
  });
});
