import type { Server } from "../types/index.js";

/**
 * Computes a Tailscale URL for a server.
 *
 * Uses env vars:
 *   TAILSCALE_TAILNET — e.g. "yak-bebop" (the tailnet name without .ts.net)
 *   TAILSCALE_HOSTNAME — fallback machine name if not in server metadata
 *
 * Server metadata keys:
 *   tailscale_hostname — the Tailscale machine name (e.g. "spark01")
 *   tailscale_port — the port the server listens on
 */
export function getTailscaleUrl(server: Server, tailnetOverride?: string): string | null {
  const tailnet = tailnetOverride || process.env.TAILSCALE_TAILNET;
  if (!tailnet) return null;

  const hostname = server.metadata?.tailscale_hostname as string | undefined
    || process.env.TAILSCALE_HOSTNAME;
  if (!hostname) return null;

  const port = server.metadata?.tailscale_port;
  const portStr = port ? `:${port}` : "";

  return `https://${hostname}.${tailnet}.ts.net${portStr}`;
}
