import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request auth context. Each incoming /mcp request may carry its own
 * `Authorization: Bearer <supabase user JWT>` — one per agent. We stash that
 * token here so the REST / edge helpers forward the *calling agent's* identity
 * to Supabase, and RLS scopes each agent to its own org / department /
 * permissions. Falls back to the global ACCESS_TOKEN when no per-request token
 * is present (single-agent / local dev).
 *
 * The store also carries a per-request `memo` map so helpers that resolve the
 * same fact more than once inside one request (e.g. `agent_whoami` for the
 * pipeline-ownership guard) can cache it without leaking across requests.
 */
interface AuthStore {
  token?: string;
  /** The caller's IP (see clientIpFrom) — keys the auth-tool rate limits. */
  clientIp?: string;
  memo: Map<string, unknown>;
}

const store = new AsyncLocalStorage<AuthStore>();

export function runWithAuth<T>(token: string | undefined, fn: () => T, clientIp?: string): T {
  return store.run({ token, clientIp, memo: new Map() }, fn);
}

export function getRequestToken(): string | undefined {
  return store.getStore()?.token;
}

export function getRequestClientIp(): string | undefined {
  return store.getStore()?.clientIp;
}

/**
 * Per-request scratch cache. `undefined` outside of `runWithAuth` (e.g. the
 * very first `initialize` request, or unit tests) — callers must treat it as
 * optional and simply skip memoisation.
 */
export function getRequestMemo(): Map<string, unknown> | undefined {
  return store.getStore()?.memo;
}
