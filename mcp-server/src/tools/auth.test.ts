import { describe, it, expect, vi, beforeEach } from 'vitest';

// auth_get_current_user / auth_sign_out used to send the shared ACCESS_TOKEN no matter who called,
// so an agent asking "who am I" got the shared identity and sign-out ended the shared session.
// They must forward the CALLER's Bearer JWT (per-request auth context), falling back to
// ACCESS_TOKEN only when the request carries none — the same rule as rest-client / edge-client.
vi.mock('../config.js', () => ({
  config: { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'anon', accessToken: 'shared-token' },
}));
vi.mock('../helpers/edge-client.js', () => ({ callEdgeFunction: vi.fn() }));

import { registerAuthTools } from './auth.js';
import { runWithAuth } from '../helpers/auth-context.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers = new Map<string, Handler>();
registerAuthTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => { handlers.set(name, handler); },
} as never);

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

function sent(): { url: string; auth: string | undefined } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, auth: (init.headers as Record<string, string>)['Authorization'] };
}

describe('auth tools act as the caller', () => {
  it("auth_get_current_user sends the caller's JWT", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'u1' }), { status: 200 }));
    const out = await runWithAuth('agent-jwt', () => handlers.get('auth_get_current_user')!({}));
    expect(out.isError).toBeUndefined();
    expect(sent()).toEqual({ url: 'https://sb.test/auth/v1/user', auth: 'Bearer agent-jwt' });
  });

  it("auth_sign_out ends only the caller's current session", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const out = await runWithAuth('agent-jwt', () => handlers.get('auth_sign_out')!({}));
    expect(out.isError).toBeUndefined();
    expect(sent()).toEqual({ url: 'https://sb.test/auth/v1/logout?scope=local', auth: 'Bearer agent-jwt' });
  });

  it('falls back to the shared ACCESS_TOKEN only when the request has no JWT', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'u1' }), { status: 200 }));
    await runWithAuth(undefined, () => handlers.get('auth_get_current_user')!({}));
    expect(sent().auth).toBe('Bearer shared-token');
  });
});
