import type { Database } from "bun:sqlite";
import type { Webhook, CreateWebhookInput } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isPrivateOrInternal(ip: string): boolean {
  const normalized = ip.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) {
    return true;
  }

  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  if (parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

export function validateWebhookUrl(urlString: string): { valid: false; error: string } | { valid: true } {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:") {
      return { valid: false, error: "Webhook URLs must use HTTPS" };
    }
    const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0" || hostname === "::") {
      return { valid: false, error: "Webhook URLs cannot target localhost" };
    }
    if (hostname === "169.254.169.254" || hostname.startsWith("169.254.")) {
      return { valid: false, error: "Webhook URLs cannot target cloud metadata endpoints" };
    }
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^169\.254\./,
      /^fc00:/i,
      /^fe80:/i,
    ];
    for (const range of privateRanges) {
      if (range.test(hostname)) {
        return { valid: false, error: "Webhook URLs cannot target private IP ranges" };
      }
    }
    return { valid: true };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Webhook URLs")) {
      return { valid: false, error: e.message };
    }
    return { valid: false, error: `Invalid webhook URL: ${urlString}` };
  }
}

async function resolveAndCheckIp(hostname: string): Promise<{ allowed: false; error: string } | { allowed: true; ip: string }> {
  try {
    const resolved = await Bun.dns.lookup(hostname);
    if (!resolved) return { allowed: false, error: `Could not resolve hostname: ${hostname}` };
    const addresses = Array.isArray(resolved) ? resolved : [resolved];
    for (const addr of addresses) {
      const ip = typeof addr === "string" ? addr : addr.address;
      if (isPrivateOrInternal(ip)) {
        return { allowed: false, error: `Hostname ${hostname} resolves to blocked address ${ip}` };
      }
    }
    const first = addresses[0] as string | { address: string } | undefined;
    return { allowed: true, ip: typeof first === "string" ? first : (first?.address ?? "") };
  } catch {
    return { allowed: true, ip: "" };
  }
}

let activeDeliveries = 0;
const MAX_CONCURRENT_DELIVERIES = 20;

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  status_code: number | null;
  response: string | null;
  attempt: number;
  created_at: string;
}

function rowToWebhook(row: any): Webhook {
  return {
    ...row,
    events: JSON.parse(row.events || "[]"),
    active: !!row.active,
    project_id: row.project_id || null,
    server_id: row.server_id || null,
    agent_id: row.agent_id || null,
    operation_id: row.operation_id || null,
  };
}

export function createWebhook(input: CreateWebhookInput, db?: Database): Webhook {
  const urlValidation = validateWebhookUrl(input.url);
  if (!urlValidation.valid) {
    throw new Error(`Invalid webhook URL: ${urlValidation.error}`);
  }
  const d = db || getDatabase();
  const id = uuid();
  d.run(
    `INSERT INTO webhooks (id, url, events, secret, active, project_id, server_id, agent_id, operation_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      id,
      input.url,
      JSON.stringify(input.events || []),
      input.secret || null,
      input.project_id || null,
      input.server_id || null,
      input.agent_id || null,
      input.operation_id || null,
      now(),
    ],
  );
  return getWebhook(id, d)!;
}

export function getWebhook(id: string, db?: Database): Webhook | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM webhooks WHERE id = ?").get(id);
  return row ? rowToWebhook(row) : null;
}

export function listWebhooks(db?: Database): Webhook[] {
  const d = db || getDatabase();
  return (d.query("SELECT * FROM webhooks ORDER BY created_at DESC").all()).map(rowToWebhook);
}

export function deleteWebhook(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  return d.run("DELETE FROM webhooks WHERE id = ?", [id]).changes > 0;
}

export function listDeliveries(webhookId?: string, limit = 50, db?: Database): WebhookDelivery[] {
  const d = db || getDatabase();
  if (webhookId) {
    return d.query("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?").all(webhookId, limit) as WebhookDelivery[];
  }
  return d.query("SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?").all(limit) as WebhookDelivery[];
}

function logDelivery(
  d: Database,
  webhookId: string,
  event: string,
  payload: string,
  statusCode: number | null,
  response: string | null,
  attempt: number,
): void {
  const id = uuid();
  d.run(
    `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status_code, response, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, webhookId, event, payload, statusCode, response, attempt, now()],
  );
}

function matchesScope(wh: Webhook, payload: Record<string, unknown>): boolean {
  if (wh.project_id && payload.project_id !== wh.project_id) return false;
  if (wh.server_id && payload.server_id !== wh.server_id) return false;
  if (wh.agent_id && payload.agent_id !== wh.agent_id) return false;
  if (wh.operation_id && payload.operation_id !== wh.operation_id) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deliverWebhook(
  wh: Webhook,
  event: string,
  body: string,
  db: Database,
): Promise<void> {
  try {
    const url = new URL(wh.url);
    const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1" || hostname === "::") {
      logDelivery(db, wh.id, event, body, null, "Blocked: localhost", 1);
      return;
    }
    const ipCheck = await resolveAndCheckIp(hostname);
    if (!ipCheck.allowed) {
      logDelivery(db, wh.id, event, body, null, `Blocked: ${ipCheck.error}`, 1);
      return;
    }
  } catch {
    logDelivery(db, wh.id, event, body, null, `Invalid URL: ${wh.url}`, 1);
    return;
  }

  if (activeDeliveries >= MAX_CONCURRENT_DELIVERIES) {
    logDelivery(db, wh.id, event, body, null, "Dropped: too many concurrent deliveries", 1);
    return;
  }

  activeDeliveries++;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (wh.secret) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", encoder.encode(wh.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
      headers["X-Webhook-Signature"] = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(wh.url, { method: "POST", headers, body });
        const respText = await resp.text().catch(() => "");
        logDelivery(db, wh.id, event, body, resp.status, respText.slice(0, 1000), attempt);
        if (resp.status < 400) return;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logDelivery(db, wh.id, event, body, null, errorMsg.slice(0, 1000), attempt);
        if (attempt === MAX_RETRY_ATTEMPTS) {
          console.error(`[webhook] Delivery failed for webhook ${wh.id} (attempt ${attempt}):`, errorMsg);
          return;
        }
      }

      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  } finally {
    activeDeliveries--;
  }
}

export async function dispatchWebhook(event: string, payload: unknown, db?: Database): Promise<void> {
  const d = db || getDatabase();
  const webhooks = listWebhooks(d).filter(w => w.active && (w.events.length === 0 || w.events.includes(event)));
  const payloadObj = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;

  await Promise.allSettled(
    webhooks.map(async (wh) => {
      if (!matchesScope(wh, payloadObj)) return;
      const body = JSON.stringify({ event, payload, timestamp: now() });
      await deliverWebhook(wh, event, body, d);
    }),
  );
}
