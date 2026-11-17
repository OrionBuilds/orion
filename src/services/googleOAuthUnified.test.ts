// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
let viewRows: Row[] = [];
let viewError: { message: string } | null = null;
const fetchCalls: { slug: string; options: Record<string, unknown> }[] = [];
const edgeCalls: { slug: string; body: Record<string, unknown> }[] = [];
let nextResponse: { ok: boolean; json: unknown } = { ok: true, json: {} };

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'google_connection_status') throw new Error(`unexpected table ${table}`);
      return { select: () => Promise.resolve({ data: viewRows, error: viewError }) };
    },
  },
}));

const response = () => ({ ok: nextResponse.ok, json: () => Promise.resolve(nextResponse.json) });
vi.mock('../lib/edgeFunction', () => ({
  fetchEdge: (slug: string, options: Record<string, unknown>) => {
    fetchCalls.push({ slug, options });
    return Promise.resolve(response());
  },
  callEdgeFunction: (slug: string, body: Record<string, unknown>) => {
    edgeCalls.push({ slug, body });
    return Promise.resolve(response());
  },
  parseEdgeFunctionError: (err: { error?: string }, fallback: string) => err.error ?? fallback,
}));

const mod = await import('./googleOAuthUnified');

beforeEach(() => {
  viewRows = [];
  viewError = null;
  fetchCalls.length = 0;
  edgeCalls.length = 0;
  nextResponse = { ok: true, json: {} };
});

describe('getGoogleConnections', () => {
  it('returns every account from the status view, primary first', async () => {
    viewRows = [
      { connection_id: 'g2', email: 'sales@corp.com', is_primary: false, connection_status: 'needs_reauth', label: 'Sales' },
      { connection_id: 'g1', email: 'jordan@gmail.com', is_primary: true, connection_status: 'active', sync_status: 'idle', last_incremental_sync_at: '2026-11-05T09:00:00Z' },
    ];
    const out = await mod.getGoogleConnections();
    expect(out.map((a) => a.email)).toEqual(['jordan@gmail.com', 'sales@corp.com']);
    expect(out[1]).toMatchObject({ label: 'Sales', needsReauth: true });
    expect(edgeCalls).toHaveLength(0);
  });

  it('is empty with no rows and never reads token tables', async () => {
    expect(await mod.getGoogleConnections()).toEqual([]);
  });

  it('falls back to the google-accounts list when the view is not there', async () => {
    viewError = { message: 'relation does not exist' };
    nextResponse = { ok: true, json: { accounts: [
      { id: 'g1', email: 'a@x.com', is_primary: true, connection_status: 'active', label: null },
      { id: 'g2', email: 'b@x.com', is_primary: false, connection_status: 'needs_reauth', last_refresh_error: 'invalid_grant' },
    ] } };
    const out = await mod.getGoogleConnections();
    expect(edgeCalls[0]).toEqual({ slug: 'google-accounts', body: { action: 'list' } });
    expect(out.map((a) => [a.id, a.isPrimary, a.needsReauth])).toEqual([['g1', true, false], ['g2', false, true]]);
    expect(out[1].error).toBe('invalid_grant');
  });

  it('throws when both the view and the list fail', async () => {
    viewError = { message: 'boom' };
    nextResponse = { ok: false, json: {} };
    await expect(mod.getGoogleConnections()).rejects.toThrow('Failed to list Google accounts');
  });
});

describe('initiateUnifiedGoogleOAuth', () => {
  beforeEach(() => { nextResponse = { ok: true, json: { authUrl: 'https://accounts.google.com/x' } }; });

  it('sends no body for a plain connect (exactly as before)', async () => {
    expect(await mod.initiateUnifiedGoogleOAuth()).toBe('https://accounts.google.com/x');
    expect(fetchCalls[0].slug).toBe('google-oauth-unified');
    expect(fetchCalls[0].options).toMatchObject({ method: 'POST', path: '/start' });
    expect(fetchCalls[0].options).not.toHaveProperty('body');
  });

  it('adds mode and login_hint only when asked', async () => {
    await mod.initiateUnifiedGoogleOAuth({ mode: 'add' });
    await mod.initiateUnifiedGoogleOAuth({ loginHint: 'sales@corp.com' });
    await mod.initiateUnifiedGoogleOAuth({ mode: 'add', loginHint: 'x@y.com' });
    expect(fetchCalls[0].options.body).toEqual({ mode: 'add' });
    expect(fetchCalls[1].options.body).toEqual({ login_hint: 'sales@corp.com' });
    expect(fetchCalls[2].options.body).toEqual({ mode: 'add', login_hint: 'x@y.com' });
  });

  it('surfaces the server error', async () => {
    nextResponse = { ok: false, json: { error: 'state signing unavailable' } };
    await expect(mod.initiateUnifiedGoogleOAuth()).rejects.toThrow('state signing unavailable');
  });
});

describe('disconnect, primary and label calls', () => {
  it('disconnect passes connection_id, or nothing for the single-account call', async () => {
    await mod.disconnectUnifiedGoogle('g2');
    await mod.disconnectUnifiedGoogle();
    expect(fetchCalls[0].options).toMatchObject({ method: 'POST', path: '/disconnect', body: { connection_id: 'g2' } });
    expect(fetchCalls[1].options).not.toHaveProperty('body');
  });

  it('surfaces "choose which account" errors from disconnect', async () => {
    nextResponse = { ok: false, json: { error: 'choose which account to disconnect' } };
    await expect(mod.disconnectUnifiedGoogle()).rejects.toThrow('choose which account');
  });

  it('set-primary and set-label go through google-accounts', async () => {
    await mod.setPrimaryGoogleAccount('g2');
    await mod.setGoogleAccountLabel('g2', '  Sales  ');
    expect(edgeCalls[0]).toEqual({ slug: 'google-accounts', body: { action: 'set-primary', connection_id: 'g2' } });
    expect(edgeCalls[1]).toEqual({ slug: 'google-accounts', body: { action: 'set-label', connection_id: 'g2', label: 'Sales' } });
  });

  it('surfaces google-accounts errors', async () => {
    nextResponse = { ok: false, json: { error: 'not your account' } };
    await expect(mod.setPrimaryGoogleAccount('x')).rejects.toThrow('not your account');
  });
});
