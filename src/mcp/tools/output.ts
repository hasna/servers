export const DEFAULT_MCP_LIST_LIMIT = 20;

export function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_MCP_LIST_LIMIT;
  return Math.max(1, Math.trunc(limit));
}

export function normalizeCursor(cursor: number | undefined): number {
  if (cursor === undefined) return 0;
  return Math.max(0, Math.trunc(cursor));
}

export function pageItems<T>(items: T[], limit: number, cursor: number): { rows: T[]; nextCursor: number | null; total: number } {
  const rows = items.slice(cursor, cursor + limit);
  const nextCursor = cursor + rows.length < items.length ? cursor + rows.length : null;
  return { rows, nextCursor, total: items.length };
}

export function truncateValue(value: unknown, max = 72): string {
  const text = value == null || value === "" ? "-" : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function appendListFooter(text: string, args: {
  shown: number;
  total?: number;
  nextCursor?: number | null;
  detailHint?: string;
  verboseHint?: boolean;
}): string {
  const totalText = args.total === undefined ? `${args.shown}` : `${args.shown} of ${args.total}`;
  const hints: string[] = [];
  if (args.verboseHint) hints.push("verbose=true");
  if (args.detailHint) hints.push(args.detailHint);
  if (args.nextCursor !== null && args.nextCursor !== undefined) hints.push(`cursor=${args.nextCursor}`);
  const suffix = hints.length > 0 ? ` Use ${hints.join(" or ")} for more.` : "";
  return `${text}\n\nShowing ${totalText}.${suffix}`;
}
