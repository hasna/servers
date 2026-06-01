---
name: skill-server-debug
description: "Debug local app/dev server lifecycle problems with servers CLI/MCP status, logs, operations, traces, and lock evidence."
user_invocable: true
---

# skill-server-debug

Use this when a dev/app server is down, stale, locked, returning the wrong URL, or confusing multiple agents.

## Rules

- Prefer MCP tools when available: `mcp__servers__get_local_server_status`, `mcp__servers__start_local_server`, `mcp__servers__stop_local_server`, and `mcp__servers__restart_local_server`.
- CLI fallback: `servers servers:debug`, `servers servers:status`, `servers servers:logs`, `servers operations`, and `servers traces`.
- Preserve evidence: command, cwd, port, health URL, PID, log path, lock owner, operation ID, and failing output.
- Do not delete shared tasks or silently bypass locks. If the owning agent is active, communicate.
- If the `servers` CLI/MCP itself is broken, create a task against `@hasna/servers`, fix it in `open-servers`, test, publish, reinstall, and verify before continuing.

## Workflow

1. Capture the complete lifecycle snapshot:
   ```bash
   servers servers:debug <slug> --json
   servers servers:status <slug> --refresh --json
   ```

2. Read logs and recent operations:
   ```bash
   servers servers:logs <slug> --lines 160
   servers operations --server <slug> --limit 20
   servers traces --server <slug> --limit 40
   ```

3. Classify the failure:
   - Not registered: run `servers servers:init ...`.
   - Wrong command/cwd/port: update with `servers servers:init ... --force`.
   - Locked by another active agent: coordinate or use `--wait-lock` with a bounded timeout.
   - Process running but not ready: inspect logs, fix the app, then `servers servers:restart`.
   - Metadata points at a dead PID: use `servers servers:status --refresh`, then start/restart through the lifecycle command.

4. Apply the smallest fix through the lifecycle command:
   ```bash
   servers servers:start <slug> --agent <agent> --reason '<reason>'
   servers servers:restart <slug> --agent <agent> --reason '<reason>'
   servers servers:stop <slug> --agent <agent> --reason '<reason>'
   ```

5. Verify from the user-visible URL, not only the command exit code.

## Done When

The root cause is identified, status/logs/traces support the conclusion, the server is either ready or intentionally stopped, and any package-level bug has a tracked fix/release task.
