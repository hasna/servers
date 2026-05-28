import { describe, expect, it } from "bun:test";
import { parseMcpArgs, isHttpMode, resolveHttpPort } from "./args.js";

describe("parseMcpArgs", () => {
  it("returns help text for --help", () => {
    const parsed = parseMcpArgs(["--help"], "0.1.3");
    expect(parsed?.type).toBe("help");
    expect(parsed?.text).toContain("Usage: servers-mcp");
    expect(parsed?.text).toContain("--http");
  });

  it("returns version text for -V", () => {
    const parsed = parseMcpArgs(["-V"], "0.1.3");
    expect(parsed).toEqual({ type: "version", text: "0.1.3" });
  });

  it("returns null for normal run arguments", () => {
    const parsed = parseMcpArgs([], "0.1.3");
    expect(parsed).toBeNull();
  });
});

describe("isHttpMode", () => {
  it("detects --http flag", () => {
    expect(isHttpMode({}, ["--http"])).toBe(true);
    expect(isHttpMode({}, [])).toBe(false);
  });

  it("detects MCP_HTTP=1", () => {
    expect(isHttpMode({ MCP_HTTP: "1" }, [])).toBe(true);
  });
});

describe("resolveHttpPort", () => {
  it("prefers --port over env and default", () => {
    expect(resolveHttpPort(8834, { MCP_HTTP_PORT: "9000" }, ["--port", "9100"])).toBe(9100);
  });

  it("uses MCP_HTTP_PORT when --port is absent", () => {
    expect(resolveHttpPort(8834, { MCP_HTTP_PORT: "9000" }, [])).toBe(9000);
  });

  it("falls back to default port", () => {
    expect(resolveHttpPort(8834, {}, [])).toBe(8834);
  });
});
