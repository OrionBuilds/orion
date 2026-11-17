// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
let viewRows: Row[] = [];
let viewError: { message: string } | null = null;
const calls: { slug: string; body: Record<string, unknown> }[] = [];
let nextResponse: { ok: boolean; json: unknown } = { ok: true, json: {} };

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'microsoft_connection_status') throw new Error(`unexpected table ${table}`);
      return { select: () => Promise.resolve({ data: viewRows, error: viewError }) };
    },
  },
}));

vi.mock('../lib/edgeFunction', () => ({
  callEdgeFunction: (slug: string, body: Record<string, unknown>) => {
    calls.push({ slug, body });
    return Promise.resolve({ ok: nextResponse.ok, json: () => Promise.resolve(nextResponse.json) });
  },
  parseEdgeFunctionError: (err: { error?: string }, fallback: string) => err.error ?? fallback,
}));

const mod = await import('./microsoftOAuth');

beforeEach(() => {
  viewRows = [];
  viewError = null;
  calls.length = 0;
  nextResponse = { ok: true, json: {} };
});

describe('getMicrosoftConnections / getMicrosoftConnection', () => {
  const rows = [
    { connection_id: 'c2', email: 'sales@a.com', is_primary: false, connection_status: 'needs_reauth', label: 'Sales' },
    { connection_id: 'c1', email: 'jordan@a.com', is_primary: true, connection_status: 'active', sync_status: 'idle', last_sync_at: '2026-11-05T09:00:00Z' },
  ];

  it('returns every account, primary first', async () => {
    viewRows = rows;
    const out = await mod.getMicrosoftConnections();
    expect(out.map((a) => a.email)).toEqual(['jordan@a.com', 'sales@a.com']);
  });

  it('getMicrosoftConnection stays the primary, with the old shape', async () => {
    viewRows = rows;
    expect(await mod.getMicrosoftConnection()).toEqual({
      connected: true, email: 'jordan@a.com', needsReauth: false, syncStatus: 'idle', lastSyncAt: '2026-11-05T09:00:00Z', error: null,
    });
  });

  it('is the empty connection with no rows, and rethrows view errors', async () => {
    expect(await mod.getMicrosoftConnection()).toEqual(mod.EMPTY_MICROSOFT_CONNECTION);
    viewError = { message: 'boom' };
    await expect(mod.getMicrosoftConnections()).rejects.toMatchObject({ message: 'boom' });
  });
});

describe('initiateMicrosoftOAuth', () => {
  beforeEach(() => { nextResponse = { ok: true, json: { authUrl: 'https://login.example/x' } }; });

  it('sends only the redirect for a plain connect (as before)', async () => {
    expect(await mod.initiateMicrosoftOAuth()).toBe('https://login.example/x');
    expect(Object.keys(calls[0].body)).toEqual(['redirect_uri']);
    expect(calls[0].slug).toBe('microsoft-oauth-start');
  });

  it('adds mode and login_hint only when asked', async () => {
    await mod.initiateMicrosoftOAuth(undefined, { mode: 'add' });
    await mod.initiateMicrosoftOAuth(undefined, { loginHint: 'sales@a.com' });
    await mod.initiateMicrosoftOAuth('clara');
    expect(calls[0].body).toMatchObject({ mode: 'add' });
    expect(calls[0].body).not.toHaveProperty('login_hint');
    expect(calls[1].body).toMatchObject({ login_hint: 'sales@a.com' });
    expect(calls[2].body).toMatchObject({ agent: 'clara' });
    expect(calls[2].body).not.toHaveProperty('mode');
  });

  it('sends account_type only when given', async () => {
    await mod.initiateMicrosoftOAuth(undefined, { mode: 'add', accountType: 'personal' });
    expect(calls[0].body).toMatchObject({ mode: 'add', account_type: 'personal' });
    await mod.initiateMicrosoftOAuth();
    expect(calls[1].body).not.toHaveProperty('account_type');
  });

  it('reads capabilities from the accounts list, disabled on failure', async () => {
    nextResponse = { ok: true, json: { accounts: [], capabilities: { external: true, personal: false } } };
    expect(await mod.getMicrosoftCapabilities()).toEqual({ external: true, personal: false });
    expect(calls[0]).toEqual({ slug: 'microsoft-accounts', body: { action: 'list' } });
    nextResponse = { ok: false, json: {} };
    expect(await mod.getMicrosoftCapabilities()).toEqual({ external: false, personal: false });
  });

  it('extracts the client id from a sign-in URL', () => {
    expect(mod.clientIdFromAuthUrl('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=abc&x=1')).toBe('abc');
    expect(mod.clientIdFromAuthUrl('nope')).toBeNull();
  });

  it('surfaces the server error', async () => {
    nextResponse = { ok: false, json: { error: 'tenant blocked' } };
    await expect(mod.initiateMicrosoftOAuth()).rejects.toThrow('tenant blocked');
  });
});

describe('disconnect, primary and label calls', () => {
  it('disconnect passes connection_id, or nothing for the single-account call', async () => {
    await mod.disconnectMicrosoft('c2');
    await mod.disconnectMicrosoft();
    expect(calls[0]).toEqual({ slug: 'microsoft-disconnect', body: { connection_id: 'c2' } });
    expect(calls[1]).toEqual({ slug: 'microsoft-disconnect', body: {} });
  });

  it('surfaces "choose which account" errors from disconnect', async () => {
    nextResponse = { ok: false, json: { error: 'choose which account to disconnect' } };
    await expect(mod.disconnectMicrosoft()).rejects.toThrow('choose which account');
  });

  it('set-primary and set-label go through microsoft-accounts', async () => {
    await mod.setPrimaryMicrosoftAccount('c2');
    await mod.setMicrosoftAccountLabel('c2', '  Sales  ');
    expect(calls[0]).toEqual({ slug: 'microsoft-accounts', body: { action: 'set-primary', connection_id: 'c2' } });
    expect(calls[1]).toEqual({ slug: 'microsoft-accounts', body: { action: 'set-label', connection_id: 'c2', label: 'Sales' } });
  });

  it('surfaces microsoft-accounts errors', async () => {
    nextResponse = { ok: false, json: { error: 'not your account' } };
    await expect(mod.setPrimaryMicrosoftAccount('x')).rejects.toThrow('not your account');
  });
});
