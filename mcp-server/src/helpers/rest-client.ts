import { config } from '../config.js';
import { getRequestToken } from './auth-context.js';
import type { RestQueryParams } from '../types.js';

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  // Prefer the calling agent's per-request JWT; fall back to the global token.
  const token = getRequestToken() || config.accessToken;
  const headers: Record<string, string> = {
    'apikey': config.supabaseAnonKey,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

// PostgREST logical operators take a parenthesised filter TREE as their value — `or=(a.eq.1,b.eq.2)`
// — never an `op.value` pair. The eq.-normalization below turned contacts_list search (and the two
// tasks tools' `or` filters) into `or=eq.(…)`, which PostgREST rejects with "failed to parse logic
// tree" — every contact search had failed since 2026-08-24. Logic keys pass through untouched.
const LOGIC_KEYS = new Set(['or', 'and', 'not.or', 'not.and']);

export function buildQueryString(params?: RestQueryParams): string {
  if (!params) return '';
  const parts: string[] = [];
  if (params.select) parts.push(`select=${encodeURIComponent(params.select)}`);
  if (params.order) parts.push(`order=${encodeURIComponent(params.order)}`);
  if (params.limit !== undefined) parts.push(`limit=${params.limit}`);
  if (params.offset !== undefined) parts.push(`offset=${params.offset}`);
  if (params.filters) {
    for (const [key, value] of Object.entries(params.filters)) {
      // PostgREST requires an operator on every filter value. Roughly a dozen
      // tools passed raw values ("active", "email") which PostgREST rejects
      // outright — unfiltered calls worked, so the broken contract only
      // surfaced when a filter was actually used. Normalize centrally: a value
      // that doesn't start with a known operator is an equality test.
      const OPERATOR = /^(eq|neq|gt|gte|lt|lte|like|ilike|match|imatch|in|is|isdistinct|cs|cd|ov|sl|sr|nxr|nxl|adj|not|fts|plfts|phfts|wfts)\./;
      const v = LOGIC_KEYS.has(key) || OPERATOR.test(value) ? value : `eq.${value}`;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function handleResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    let errorData;
    try {
      errorData = JSON.parse(text);
    } catch {
      errorData = { message: text || res.statusText };
    }
    throw new Error(
      `API Error ${res.status}: ${errorData.message || errorData.error || res.statusText}${errorData.details ? ` - ${errorData.details}` : ''}`,
    );
  }
  if (!text) return null;
  return JSON.parse(text);
}

export async function restGet(table: string, params?: RestQueryParams): Promise<unknown> {
  const qs = buildQueryString(params);
  const extraHeaders: Record<string, string> = {};
  if (params?.prefer) extraHeaders['Prefer'] = params.prefer;
  if (params?.accept) extraHeaders['Accept'] = params.accept;
  const url = `${config.supabaseUrl}/rest/v1/${table}${qs}`;
  const res = await fetch(url, { method: 'GET', headers: buildHeaders(extraHeaders) });
  return handleResponse(res);
}

export async function restPost(
  table: string,
  body: unknown,
  prefer?: string,
): Promise<unknown> {
  const headers = buildHeaders(prefer ? { Prefer: prefer } : undefined);
  const url = `${config.supabaseUrl}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return handleResponse(res);
}

export async function restPatch(
  table: string,
  filters: Record<string, string>,
  body: unknown,
  prefer?: string,
): Promise<unknown> {
  const qs = buildQueryString({ filters });
  const headers = buildHeaders(prefer ? { Prefer: prefer } : undefined);
  const url = `${config.supabaseUrl}/rest/v1/${table}${qs}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  return handleResponse(res);
}

/**
 * Call a Postgres function via PostgREST RPC under the caller's JWT. Used for
 * SECURITY DEFINER functions like claim_due_agent_task_runs that must run with
 * the agent's auth.uid() bound.
 */
export async function restRpc(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  const url = `${config.supabaseUrl}/rest/v1/rpc/${fn}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(args ?? {}),
  });
  return handleResponse(res);
}

export async function restDelete(
  table: string,
  filters: Record<string, string>,
): Promise<unknown> {
  const qs = buildQueryString({ filters });
  const url = `${config.supabaseUrl}/rest/v1/${table}${qs}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: buildHeaders(),
  });
  return handleResponse(res);
}
