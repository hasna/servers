import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findListenerPids,
  isAlive,
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
