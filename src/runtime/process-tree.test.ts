import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverServerPids,
  findListenerPids,
  isAlive,
  isGroupAlive,
  killTree,
} from "./process-tree.js";

const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "process-tree-test-"));
}

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("no port")));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
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

describe("findListenerPids", () => {
  it("finds the pid listening on a TCP port", async () => {
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const http=require('http');const s=http.createServer((q,r)=>r.end('ok'));s.listen(${port},'127.0.0.1');setInterval(()=>{},1000);`,
      ],
      { stdio: "ignore" },
    );
    spawned.push(child.pid!);
    expect(await waitFor(() => findListenerPids(port).includes(child.pid!))).toBe(true);
  });

  it("returns an empty array when nothing listens", async () => {
    const port = await getFreePort();
    expect(findListenerPids(port)).toEqual([]);
  });
});

describe("isAlive", () => {
  it("treats zombie processes as not alive", async () => {
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
      spawned.push(parentPid);

      expect(await waitFor(() => existsSync(pidFile))).toBe(true);
      const childPid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
      expect(await waitFor(() => processStat(childPid).startsWith("Z"))).toBe(true);

      expect(isAlive(childPid)).toBe(false);
    } finally {
      if (parentPid) {
        try {
          process.kill(parentPid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats zombie process-group leaders as not alive", async () => {
    const dir = makeTempDir();
    const pidFile = join(dir, "child.pid");
    let parentPid: number | undefined;

    try {
      const parent = spawn(
        "bash",
        ["-lc", "set -m; sleep 0.1 & echo $! > \"$1\"; exec sleep 30", "_", pidFile],
        { stdio: "ignore" },
      );
      parentPid = parent.pid!;
      spawned.push(parentPid);

      expect(await waitFor(() => existsSync(pidFile))).toBe(true);
      const childPid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
      expect(await waitFor(() => processStat(childPid).startsWith("Z"))).toBe(true);

      expect(isAlive(childPid)).toBe(false);
      expect(isGroupAlive(childPid)).toBe(false);
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

describe("discoverServerPids", () => {
  it("does not match same-cwd processes on a generic package script name alone", async () => {
    const dir = makeTempDir();
    try {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000); // dev helper"],
        { cwd: dir, stdio: "ignore" },
      );
      const childPid = child.pid!;
      spawned.push(childPid);
      expect(await waitFor(() => isAlive(childPid))).toBe(true);

      expect(discoverServerPids({ command: "bun run dev", cwd: dir })).not.toContain(childPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands package scripts before matching same-cwd process commands", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node actual-server.js" } }));
      writeFileSync(join(dir, "actual-server.js"), "setInterval(() => {}, 1000);");

      const child = spawn(process.execPath, ["actual-server.js"], {
        cwd: dir,
        stdio: "ignore",
      });
      const childPid = child.pid!;
      spawned.push(childPid);
      expect(await waitFor(() => isAlive(childPid))).toBe(true);

      expect(discoverServerPids({ command: "bun run dev", cwd: dir })).toContain(childPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands npm start as package scripts.start", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { start: "node actual-start-server.js" } }));
      writeFileSync(join(dir, "actual-start-server.js"), "setInterval(() => {}, 1000);");

      const child = spawn(process.execPath, ["actual-start-server.js"], {
        cwd: dir,
        stdio: "ignore",
      });
      const childPid = child.pid!;
      spawned.push(childPid);
      expect(await waitFor(() => isAlive(childPid))).toBe(true);

      expect(discoverServerPids({ command: "npm start", cwd: dir })).toContain(childPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches expanded script tokens exactly instead of by substring", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      writeFileSync(join(dir, "vite"), "setInterval(() => {}, 1000);");

      const vite = spawn(process.execPath, ["vite"], { cwd: dir, stdio: "ignore" });
      const vitestHelper = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000); // vitest helper"],
        { cwd: dir, stdio: "ignore" },
      );
      const vitePid = vite.pid!;
      const vitestPid = vitestHelper.pid!;
      spawned.push(vitePid, vitestPid);
      expect(await waitFor(() => isAlive(vitePid) && isAlive(vitestPid))).toBe(true);

      const discovered = discoverServerPids({ command: "bun run dev", cwd: dir });
      expect(discovered).toContain(vitePid);
      expect(discovered).not.toContain(vitestPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands npm run script commands with options before and after run", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { start: "node actual-option-server.js" } }));
      writeFileSync(join(dir, "actual-option-server.js"), "setInterval(() => {}, 1000);");

      const child = spawn(process.execPath, ["actual-option-server.js"], {
        cwd: dir,
        stdio: "ignore",
      });
      const childPid = child.pid!;
      spawned.push(childPid);
      expect(await waitFor(() => isAlive(childPid))).toBe(true);

      expect(discoverServerPids({ command: "npm run --silent start", cwd: dir })).toContain(childPid);
      expect(discoverServerPids({ command: "npm --silent run start", cwd: dir })).toContain(childPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches npm start default server.js when scripts.start is absent", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "default-start-app" }));
      writeFileSync(join(dir, "server.js"), "setInterval(() => {}, 1000);");

      const child = spawn(process.execPath, ["server.js"], {
        cwd: dir,
        stdio: "ignore",
      });
      const childPid = child.pid!;
      spawned.push(childPid);
      expect(await waitFor(() => isAlive(childPid))).toBe(true);

      expect(discoverServerPids({ command: "npm start", cwd: dir })).toContain(childPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not apply npm start default when package.json is invalid", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "package.json"), "{ invalid json");
      writeFileSync(join(dir, "server.js"), "setInterval(() => {}, 1000);");

      const child = spawn(process.execPath, ["server.js"], {
        cwd: dir,
        stdio: "ignore",
      });
      const childPid = child.pid!;
      spawned.push(childPid);
      expect(await waitFor(() => isAlive(childPid))).toBe(true);

      expect(discoverServerPids({ command: "npm start", cwd: dir })).not.toContain(childPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not match generic npm lifecycle names without package scripts", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lifecycle-no-scripts" }));

      const stopHelper = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000); // stop helper"],
        { cwd: dir, stdio: "ignore" },
      );
      const restartHelper = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000); // restart helper"],
        { cwd: dir, stdio: "ignore" },
      );
      const stopPid = stopHelper.pid!;
      const restartPid = restartHelper.pid!;
      spawned.push(stopPid, restartPid);
      expect(await waitFor(() => isAlive(stopPid) && isAlive(restartPid))).toBe(true);

      expect(discoverServerPids({ command: "npm stop", cwd: dir })).not.toContain(stopPid);
      expect(discoverServerPids({ command: "npm restart", cwd: dir })).not.toContain(restartPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("killTree", () => {
  it("kills a detached grandchild that escaped the recorded process group", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    try {
      writeFileSync(
        join(dir, "wrapper.js"),
        `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const port = ${port};
const child = spawn(process.execPath, ["-e",
  "const http=require('node:http');process.on('SIGTERM',()=>{});const s=http.createServer((_q,r)=>r.end('ok'));s.listen(" + port + ",'127.0.0.1');setInterval(()=>{},1000);"
], { stdio: "ignore", detached: true });
child.unref();
writeFileSync(join(process.cwd(), "child.txt"), String(child.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      );
      const wrapper = spawn("bash", ["-lc", "node wrapper.js"], {
        cwd: dir,
        detached: true,
        stdio: "ignore",
      });
      wrapper.unref();
      const wrapperPid = wrapper.pid!;
      spawned.push(wrapperPid);

      expect(await waitFor(() => existsSync(join(dir, "child.txt")))).toBe(true);
      const childPid = Number.parseInt(readFileSync(join(dir, "child.txt"), "utf-8"), 10);
      spawned.push(childPid);
      expect(await waitFor(() => isAlive(childPid))).toBe(true);

      const result = await killTree({
        pid: wrapperPid,
        port,
        command: "node wrapper.js",
        cwd: dir,
        gracePeriodMs: 500,
      });

      expect(result.stopped).toBe(true);
      expect(await waitFor(() => !isAlive(childPid))).toBe(true);
      expect(isAlive(childPid)).toBe(false);
      expect(findListenerPids(port)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports stopped:false and the survivors when a SIGTERM-ignoring tree is given no force time", async () => {
    const dir = makeTempDir();
    const port = await getFreePort();
    try {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `process.on('SIGTERM',()=>{});const http=require('http');const s=http.createServer((q,r)=>r.end('ok'));s.listen(${port},'127.0.0.1');setInterval(()=>{},1000);`,
        ],
        { cwd: dir, stdio: "ignore" },
      );
      const childPid = child.pid!;
      spawned.push(childPid);
      expect(await waitFor(() => isAlive(childPid))).toBe(true);

      // escalate=false: send SIGTERM only (ignored), never SIGKILL -> still alive
      const result = await killTree({
        pid: childPid,
        port,
        command: "node",
        cwd: dir,
        gracePeriodMs: 300,
        escalate: false,
      });

      expect(result.stopped).toBe(false);
      expect(result.survivors).toContain(childPid);
      expect(isAlive(childPid)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
