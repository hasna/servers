// SDK entry — re-export all public APIs
export type {
  Server,
  ServerStatus,
  ServerOperation,
  OperationType,
  OperationStatus,
  Trace,
  Agent,
  AgentStatus,
  Webhook,
  ResourceLock,
  Project,
  CreateServerInput,
  UpdateServerInput,
  CreateOperationInput,
  UpdateOperationInput,
  CreateTraceInput,
  RegisterAgentInput,
  CreateWebhookInput,
  CreateProjectInput,
  AgentConflictError,
} from "./types/index.js";

export {
  ServerNotFoundError,
  ServerLockedError,
  OperationNotFoundError,
  AgentNotFoundError,
  LockError,
} from "./types/index.js";

export {
  getDatabase,
  closeDatabase,
  resetDatabase,
  now,
  uuid,
  isLockExpired,
  lockExpiryCutoff,
  clearExpiredLocks,
  resolvePartialId,
} from "./db/database.js";

export { runMigrations } from "./db/schema.js";

export {
  createServer,
  getServer,
  getServerBySlug,
  listServers,
  updateServer,
  deleteServer,
  lockServer,
  unlockServer,
  heartbeatServer,
} from "./db/servers.js";

export {
  createOperation,
  getOperation,
  listOperations,
  updateOperation,
  startOperation,
  completeOperation,
  failOperation,
  cancelOperation,
  deleteOperation,
} from "./db/operations.js";

export {
  createTrace,
  getTrace,
  listTraces,
  listTracesByAgent,
  deleteTracesByServer,
} from "./db/traces.js";

export {
  registerAgent,
  getAgent,
  getAgentByName,
  getAgentBySession,
  listAgents,
  heartbeatAgent,
  archiveAgent,
  releaseAgent,
  updateAgent,
} from "./db/agents.js";

export {
  acquireLock,
  releaseLock,
  checkLock,
  cleanExpiredLocks,
  getLocksByAgent,
} from "./db/locks.js";

export {
  createWebhook,
  getWebhook,
  listWebhooks,
  deleteWebhook,
  listDeliveries,
  dispatchWebhook,
  validateWebhookUrl,
} from "./db/webhooks.js";

export {
  createProject,
  getProject,
  getProjectByPath,
  listProjects,
  updateProject,
  deleteProject,
} from "./db/projects.js";
