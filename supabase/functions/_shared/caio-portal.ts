// CAIO Delivery — client-portal response shaping + input validation.
// The data itself comes from the service-role-only SQL functions
// caio_portal_payload / caio_portal_document (migration 20261105130000); this
// module only validates ids and shapes what the edge function returns.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the id if it is a well-formed uuid, else null (callers answer 403/404 without a DB hit). */
export function parseUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/** RPC result -> client response. NULL (portal off / no engagement) is `{ enabled: false }`. */
export function shapeCaioPortal(rpcData: unknown): Record<string, unknown> {
  if (!rpcData || typeof rpcData !== "object" || Array.isArray(rpcData)) return { enabled: false };
  return { enabled: true, ...(rpcData as Record<string, unknown>) };
}

/** RPC result -> document body, or null when the caller should answer 404. */
export function shapeCaioDocument(rpcData: unknown): Record<string, unknown> | null {
  if (!rpcData || typeof rpcData !== "object" || Array.isArray(rpcData)) return null;
  return rpcData as Record<string, unknown>;
}
