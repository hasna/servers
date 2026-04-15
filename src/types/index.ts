// Server statuses
export const SERVER_STATUSES = [
  "online",
  "offline",
  "starting",
  "stopping",
  "restarting",
  "deploying",
  "maintenance",
  "unknown",
] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

// Operation types
export const OPERATION_TYPES = [
  "start",
  "stop",
  "restart",
  "deploy",
  "configure",
  "status_check",
  "custom",
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

// Operation statuses
export const OPERATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

// Agent status
export type AgentStatus = "active" | "archived";

// ── Server ──────────────────────────────────────────────────────────────────

export interface Server {
  id: string;
  name: string;
  slug: string;
  hostname: string | null;
  path: string | null;
  description: string | null;
  status: ServerStatus;
  metadata: Record<string, unknown>;
  project_id: string | null;
  locked_by: string | null;
  locked_at: string | null;
  last_heartbeat: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerRow {
  id: string;
  name: string;
  slug: string;
  hostname: string | null;
  path: string | null;
  description: string | null;
  status: string;
  metadata: string | null;
  project_id: string | null;
  locked_by: string | null;
  locked_at: string | null;
  last_heartbeat: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateServerInput {
  name: string;
  slug?: string;
  hostname?: string;
  path?: string;
  description?: string;
  status?: ServerStatus;
  metadata?: Record<string, unknown>;
  project_id?: string;
}

export interface UpdateServerInput {
  name?: string;
  slug?: string;
  hostname?: string | null;
  path?: string | null;
  description?: string | null;
  status?: ServerStatus;
  metadata?: Record<string, unknown>;
  project_id?: string | null;
  last_heartbeat?: string;
}

// ── Server Operation ────────────────────────────────────────────────────────

export interface ServerOperation {
  id: string;
  server_id: string;
  agent_id: string | null;
  session_id: string | null;
  operation_type: OperationType;
  status: OperationStatus;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

export interface ServerOperationRow {
  id: string;
  server_id: string;
  agent_id: string | null;
  session_id: string | null;
  operation_type: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  metadata: string | null;
}

export interface CreateOperationInput {
  server_id: string;
  operation_type: OperationType;
  agent_id?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateOperationInput {
  status: OperationStatus;
  completed_at?: string | null;
  error_message?: string | null;
}

// ── Trace (audit trail) ─────────────────────────────────────────────────────

export interface Trace {
  id: string;
  server_id: string;
  operation_id: string | null;
  agent_id: string | null;
  event: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface TraceRow {
  id: string;
  server_id: string;
  operation_id: string | null;
  agent_id: string | null;
  event: string;
  details: string | null;
  created_at: string;
}

export interface CreateTraceInput {
  server_id: string;
  operation_id?: string | null;
  agent_id?: string | null;
  event: string;
  details?: Record<string, unknown>;
}

// ── Agent (ported from todos) ───────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  capabilities: string[];
  status: AgentStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  last_seen_at: string;
  session_id: string | null;
  working_dir: string | null;
}

export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  capabilities: string | null;
  status: string;
  metadata: string | null;
  created_at: string;
  last_seen_at: string;
  session_id: string | null;
  working_dir: string | null;
}

export interface RegisterAgentInput {
  name: string;
  description?: string;
  capabilities?: string[];
  session_id?: string;
  working_dir?: string;
  force?: boolean;
}

export interface AgentConflictError {
  conflict: true;
  existing_id: string;
  existing_name: string;
  last_seen_at: string;
  session_hint: string | null;
  working_dir: string | null;
  message: string;
}

// ── Webhook ─────────────────────────────────────────────────────────────────

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  active: boolean;
  project_id: string | null;
  server_id: string | null;
  agent_id: string | null;
  operation_id: string | null;
  created_at: string;
}

export interface CreateWebhookInput {
  url: string;
  events?: string[];
  secret?: string;
  project_id?: string;
  server_id?: string;
  agent_id?: string;
  operation_id?: string;
}

// ── Resource Lock ───────────────────────────────────────────────────────────

export interface ResourceLock {
  resource_type: string;
  resource_id: string;
  agent_id: string;
  lock_type: string;
  locked_at: string;
  expires_at: string;
}

// ── Project ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  description?: string;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class ServerNotFoundError extends Error {
  static readonly code = "SERVER_NOT_FOUND";
  constructor(public serverId: string) {
    super(`Server not found: ${serverId}`);
    this.name = "ServerNotFoundError";
  }
}

export class ServerLockedError extends Error {
  static readonly code = "SERVER_LOCKED";
  constructor(
    public serverId: string,
    public lockedBy: string,
  ) {
    super(`Server ${serverId} is locked by ${lockedBy}`);
    this.name = "ServerLockedError";
  }
}

export class OperationNotFoundError extends Error {
  static readonly code = "OPERATION_NOT_FOUND";
  constructor(public operationId: string) {
    super(`Operation not found: ${operationId}`);
    this.name = "OperationNotFoundError";
  }
}

export class AgentNotFoundError extends Error {
  static readonly code = "AGENT_NOT_FOUND";
  constructor(public agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

export class LockError extends Error {
  static readonly code = "LOCK_ERROR";
  constructor(
    public resourceId: string,
    public lockedBy: string,
  ) {
    super(`Resource ${resourceId} is locked by ${lockedBy}`);
    this.name = "LockError";
  }
}
