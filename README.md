# @hasna/servers

Server management for AI coding agents — CLI + MCP server.

## Overview

Manage servers, agents, operations, webhooks, and audit trails across repositories. Built on SQLite with per-project database discovery.

## Features

- **Server lifecycle**: online, offline, starting, stopping, restarting, deploying, maintenance
- **Agent registration**: conflict detection, stale takeover (30 min), session binding
- **Resource locking**: advisory/exclusive locks with auto-expiry
- **Operations**: state machine (pending → running → completed/failed/cancelled)
- **Webhooks**: HTTPS-only with SSRF prevention, HMAC signing, retry with exponential backoff
- **Audit trails**: trace events by server, operation, or agent
- **Per-project DB**: `.servers/servers.db` auto-discovered from repo root
- **MCP server**: stdio transport with modular tool registration
- **CLI**: Commander.js interface with colored output

## CLI

```bash
# List servers
servers servers

# Create a server
servers servers:add --name "api-server" --project "my-project"

# Register a Tailscale-accessible server
servers servers:add --name "api-server" --tailscale-hostname spark01 --tailscale-port 3000

# Register an agent
servers agent:register --name "marcus" --description "architect"

# List operations
servers operations --server "api-server"

# Create a webhook
servers webhook:add --url "https://hooks.example.com/notify" --events "server.started"

# Show webhook delivery logs
servers webhooks:logs
```

## MCP

Run as MCP server with stdio transport:

```bash
servers-mcp
```

## SDK

```typescript
import { createServer, getServer, registerAgent, listAgents } from "@hasna/servers";

const server = createServer({ name: "api-server" });
const agent = registerAgent({ name: "marcus", capabilities: ["review"] });
```

## Database

SQLite via `bun:sqlite` with WAL mode. Database location:
1. `SERVERS_DB_PATH` env var
2. Nearest `.servers/servers.db` walking up from cwd
3. `~/.hasna/servers/servers.db` (default)

## Install

```bash
bun add -g @hasna/servers
```
