---
name: skill-server-restart
description: "Restart local app/dev servers safely through the servers CLI/MCP using lifecycle locks, readiness waits, and operation traces."
user_invocable: true
---

# skill-server-restart

Use this when an existing app/dev server must be restarted after code, env, dependency, or configuration changes.

## Rules

- Prefer MCP tools when available: `mcp__servers__restart_local_server`, `mcp__servers__get_local_server_status`, and `mcp__servers__stop_local_server`.
- CLI fallback: `servers servers:restart`, `servers servers:status`, `servers servers:debug`, and `servers servers:logs`.
- Do not `pkill`, `kill -9`, or restart by hand while a `server-runtime` lock exists. Inspect the lock and coordinate with the owner.
- Always include `--agent <name>` and `--reason <why>`.
- If the start command, cwd, port, or health URL changed, run `servers servers:init ... --force` first.

## Workflow

1. Inspect the current registered state:
   ```bash
   servers servers:status <slug> --refresh
   servers servers:debug <slug>
   ```

2. If another agent owns the lifecycle lock, either wait intentionally or coordinate:
   ```bash
   servers servers:restart <slug> --agent <agent> --reason '<reason>' --wait-lock --lock-timeout 300000
   ```

3. Restart and wait for readiness:
   ```bash
   servers servers:restart <slug> --agent <agent> --reason '<reason>' --timeout 60000 --stop-timeout 15000
   ```

4. Confirm the new process is healthy:
   ```bash
   servers servers:status <slug> --refresh
   servers servers:logs <slug> --lines 80
   ```

5. If readiness fails, use `servers servers:debug` and logs. The lifecycle runtime should clean up a failed spawned process; do not start another unmanaged process to compensate.

## Done When

The restart operation is completed, the observed status is online/ready, the PID/log metadata is current, and traces show who restarted the server and why.
