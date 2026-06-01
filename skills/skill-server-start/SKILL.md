---
name: skill-server-start
description: "Start or register local app/dev servers through the servers CLI/MCP with locks, readiness checks, logs, and agent traces."
user_invocable: true
---

# skill-server-start

Use this when a repo needs a dev/app server started, registered, or made reachable for agents.

## Rules

- Prefer MCP tools when available: `mcp__servers__init_local_server`, `mcp__servers__start_local_server`, and `mcp__servers__get_local_server_status`.
- CLI fallback: `servers servers:init`, `servers servers:start`, `servers servers:status`, `servers servers:logs`, and `servers servers:debug`.
- Do not start long-running servers with bare `bun run dev &`, `npm run dev &`, `nohup`, or unmanaged tmux panes.
- For cross-machine access, make the app command bind to `0.0.0.0` and record the port. Use `http://<machine>:<port>` or the computed Tailscale URL.
- Always pass `--agent <name>` and `--reason <why>` so operations and traces explain who touched the server.

## Workflow

1. Verify the installed surface:
   ```bash
   servers --version
   servers-mcp --version
   servers --help | grep 'servers:start'
   ```

2. Register or update the app server:
   ```bash
   servers servers:init --name <slug> --path . --command '<start command>' --port <port> --force
   ```
   If the command serves other machines, include the app's host flag, for example `bun run dev --host 0.0.0.0`.

3. Start through the lifecycle lock:
   ```bash
   servers servers:start <slug> --agent <agent> --reason '<reason>' --timeout 60000
   ```

4. Confirm readiness and record the observed status:
   ```bash
   servers servers:status <slug> --refresh
   ```

5. If start fails, inspect before changing anything:
   ```bash
   servers servers:debug <slug>
   servers servers:logs <slug> --lines 120
   ```

## Done When

The server is registered, `servers servers:status <slug> --refresh` reports ready/online, the command/port/log path are visible in `servers servers:debug`, and no unmanaged duplicate process was started.
