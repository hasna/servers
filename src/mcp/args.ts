import { DEFAULT_MCP_HTTP_PORT } from "./http.js";
import { parseStrictInteger } from "../utils/integers.js";

export interface ParsedMcpArgResult {
  type: "help" | "version";
  text: string;
}

export function isHttpMode(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes("--http") || env.MCP_HTTP === "1";
}

function readOptionValue(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) return argv[index + 1] ?? "";
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

export function resolveHttpPort(
  defaultPort: number = DEFAULT_MCP_HTTP_PORT,
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): number {
  const portValue = readOptionValue(argv, "--port");
  if (portValue !== undefined) {
    return parseStrictInteger(portValue, "--port", { min: 1, max: 65535 });
  }
  if (env.MCP_HTTP_PORT) {
    return parseStrictInteger(env.MCP_HTTP_PORT, "MCP_HTTP_PORT", { min: 1, max: 65535 });
  }
  return defaultPort;
}

export function parseMcpArgs(argv: string[], version: string): ParsedMcpArgResult | null {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      type: "help",
      text: [
        "Usage: servers-mcp [options]",
        "",
        "Start the @hasna/servers MCP server (stdio by default).",
        "",
        "Options:",
        "  --http         Serve MCP over Streamable HTTP on 127.0.0.1",
        "  --port <n>     HTTP port (--http or MCP_HTTP=1; default: 8834)",
        "  -h, --help     display help for command",
        "  -V, --version  output the version number",
        "",
        "Environment:",
        "  MCP_HTTP=1         Enable HTTP mode",
        "  MCP_HTTP_PORT=<n>  HTTP port when MCP_HTTP=1",
      ].join("\n"),
    };
  }

  if (argv.includes("--version") || argv.includes("-V")) {
    return { type: "version", text: version };
  }

  return null;
}
