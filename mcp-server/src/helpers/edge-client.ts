import { config } from '../config.js';
import { getRequestToken } from './auth-context.js';

export async function callEdgeFunction(
  slug: string,
  body?: unknown,
  method: string = 'POST',
  opts: { path?: string; query?: Record<string, string> } = {},
): Promise<unknown> {
  // Prefer the calling agent's per-request JWT; fall back to the global token.
  const token = getRequestToken() || config.accessToken;
  const headers: Record<string, string> = {
    'apikey': config.supabaseAnonKey,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Some functions are path-routed (google-oauth-unified/start, ...).
  let url = `${config.supabaseUrl}/functions/v1/${slug}`;
  if (opts.path) url += `/${opts.path.replace(/^\/+/, '')}`;
  if (opts.query && Object.keys(opts.query).length > 0) url += `?${new URLSearchParams(opts.query).toString()}`;
  const options: RequestInit = { method, headers };
  if (body !== undefined && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();

  if (!res.ok) {
    let errorData;
    try {
      errorData = JSON.parse(text);
    } catch {
      errorData = { message: text || res.statusText };
    }
    throw new Error(
      `Edge Function '${slug}' error ${res.status}: ${errorData.error || errorData.message || res.statusText}`,
    );
  }

  if (!text) return { success: true };
  return JSON.parse(text);
}

/** Calls an edge function described by a route (see helpers/workspace-provider.ts). */
export function callEdgeRoute(route: {
  slug: string;
  method?: string;
  path?: string;
  query?: Record<string, string>;
  body?: unknown;
}): Promise<unknown> {
  const method = route.method ?? 'POST';
  return callEdgeFunction(route.slug, method === 'GET' ? undefined : (route.body ?? {}), method, {
    path: route.path,
    query: route.query,
  });
}
