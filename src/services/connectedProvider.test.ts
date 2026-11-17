import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

// Tiny chainable stand-in for the supabase query builder (eq/in/maybeSingle + thenable).
function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let single = false;
  const run = () => {
    const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    return { data: single ? rows[0] ?? null : rows, error: null };
  };
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
  };
  return q;
}

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (t: string) => query(t),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'uBoth' } } }) },
  },
}));

const mod = await import('./connectedProvider');

beforeEach(() => {
  mod.invalidateProviderCache();
  tables.organizations = [
    { id: 'orgMs', default_workspace_provider: 'microsoft' },
    { id: 'orgG', default_workspace_provider: 'google' },
    { id: 'orgNone', default_workspace_provider: null },
  ];
  tables.users = [{ id: 'uBoth', organization_id: 'orgG' }];
  tables.user_connected_accounts = [
    { user_id: 'uMs', provider: 'microsoft_365', status: 'connected', provider_account_email: 'ms@x.com' },
    { user_id: 'uOld', provider: 'google_gmail', status: 'connected', provider_account_email: 'old@gmail.com' },
    { user_id: 'uErr', provider: 'microsoft_365', status: 'error', provider_account_email: 'e@x.com' },
    { user_id: 'uBoth', provider: 'microsoft_365', status: 'connected', provider_account_email: 'b@x.com' },
    { user_id: 'uBoth', provider: 'google_workspace', status: 'connected', provider_account_email: 'b@gmail.com' },
  ];
});

describe('pure helpers', () => {
  it('normalises provider values', () => {
    expect(mod.normalizeAccountProvider('google_workspace')).toBe('google');
    expect(mod.normalizeAccountProvider('google_gmail')).toBe('google');
    expect(mod.normalizeAccountProvider('microsoft_365')).toBe('microsoft');
    expect(mod.normalizeAccountProvider('twilio')).toBeNull();
  });

  it('picks prefer > org default > first connected', () => {
    expect(mod.pickProvider([])).toBeNull();
    expect(mod.pickProvider(['microsoft', 'google'])).toBe('microsoft');
    expect(mod.pickProvider(['microsoft', 'google'], { orgDefault: 'google' })).toBe('google');
    expect(mod.pickProvider(['microsoft', 'google'], { prefer: 'google', orgDefault: 'microsoft' })).toBe('google');
    expect(mod.pickProvider(['google'], { prefer: 'microsoft' })).toBe('google');
  });

  it('ignores non-connected rows', () => {
    expect(mod.connectedProviders([{ provider: 'microsoft_365', status: 'error' }])).toEqual([]);
  });
});

describe('getProviderState', () => {
  it('Microsoft-only user resolves to microsoft (no regression)', async () => {
    const s = await mod.getProviderState('uMs', 'orgMs');
    expect(s).toMatchObject({ connected: ['microsoft'], primary: 'microsoft', emails: { microsoft: 'ms@x.com' } });
  });

  it('legacy google_gmail row counts as Google', async () => {
    const s = await mod.getProviderState('uOld', 'orgNone');
    expect(s.primary).toBe('google');
    expect(s.emails.google).toBe('old@gmail.com');
  });

  it('errored connection resolves to none', async () => {
    expect((await mod.getProviderState('uErr', null)).primary).toBeNull();
  });

  it('user with both follows the org default', async () => {
    expect((await mod.getProviderState('uBoth', 'orgG')).primary).toBe('google');
    mod.invalidateProviderCache();
    expect((await mod.getProviderState('uBoth', 'orgMs')).primary).toBe('microsoft');
    mod.invalidateProviderCache();
    expect((await mod.getProviderState('uBoth', 'orgNone')).primary).toBe('microsoft');
  });

  it('resolveUserProvider honours an explicit preference', async () => {
    expect(await mod.resolveUserProvider('uBoth', { organizationId: 'orgMs', prefer: 'google' })).toBe('google');
  });

  it('getMyProviderState looks up the org of the signed-in user', async () => {
    const s = await mod.getMyProviderState();
    expect(s.orgDefault).toBe('google');
    expect(s.primary).toBe('google');
  });
});

describe('files provider preference (Media switcher)', () => {
  it('round-trips, ignores junk, and clears', () => {
    mod.setFilesProviderPreference(null);
    expect(mod.getFilesProviderPreference()).toBeNull();
    mod.setFilesProviderPreference('google');
    expect(mod.getFilesProviderPreference()).toBe('google');
    localStorage.setItem('orion_files_provider', 'dropbox');
    expect(mod.getFilesProviderPreference()).toBeNull();
    mod.setFilesProviderPreference('microsoft');
    expect(mod.getFilesProviderPreference()).toBe('microsoft');
    mod.setFilesProviderPreference(null);
    expect(mod.getFilesProviderPreference()).toBeNull();
  });

  it('a preference for a provider that is not connected is ignored', () => {
    expect(mod.pickProvider(['microsoft'], { prefer: 'google' })).toBe('microsoft');
  });
});

describe('Microsoft account list in provider state', () => {
  it('exposes accounts.microsoft while emails.microsoft stays the primary mirror', async () => {
    tables.microsoft_connection_status = [
      { connection_id: 'c2', email: 'sales@x.com', is_primary: false, connection_status: 'active', label: 'Sales' },
      { connection_id: 'c1', email: 'b@x.com', is_primary: true, connection_status: 'active' },
    ];
    const s = await mod.getProviderState('uBoth', 'orgG');
    expect(s.emails.microsoft).toBe('b@x.com');
    expect(s.accounts.microsoft.map((a) => [a.id, a.isPrimary])).toEqual([['c1', true], ['c2', false]]);
    expect(s.accounts.microsoft[1].label).toBe('Sales');
    delete tables.microsoft_connection_status;
  });

  it('is an empty list when the user has no Microsoft accounts', async () => {
    const s = await mod.getProviderState('uOld', 'orgNone');
    expect(s.accounts.microsoft).toEqual([]);
  });
});

describe('files connection resolution', () => {
  const two = [
    { id: 'c1', email: 'a@x.com', label: null, isPrimary: true, status: 'active' },
    { id: 'c2', email: 'b@x.com', label: null, isPrimary: false, status: 'active' },
  ];
  it('sends nothing for one account, an unknown choice, or no choice', () => {
    expect(mod.resolveFilesConnectionId([two[0]], 'c1')).toBeUndefined();
    expect(mod.resolveFilesConnectionId(two, 'zzz')).toBeUndefined();
    expect(mod.resolveFilesConnectionId(two, null)).toBeUndefined();
  });
  it('sends the saved account when the user has 2+', () => {
    expect(mod.resolveFilesConnectionId(two, 'c2')).toBe('c2');
  });
});

describe('Google account list in provider state', () => {
  it('exposes accounts.google while emails.google stays the primary mirror', async () => {
    tables.google_connection_status = [
      { connection_id: 'g2', email: 'sales@corp.com', is_primary: false, connection_status: 'needs_reauth', label: 'Sales' },
      { connection_id: 'g1', email: 'b@gmail.com', is_primary: true, connection_status: 'active' },
    ];
    const s = await mod.getProviderState('uBoth', 'orgG');
    expect(s.emails.google).toBe('b@gmail.com');
    expect(s.accounts.google.map((a) => [a.id, a.isPrimary, a.status])).toEqual([['g1', true, 'active'], ['g2', false, 'needs_reauth']]);
    expect(s.accounts.google[1].label).toBe('Sales');
    // the slim shape carries no sync or scope detail
    expect(Object.keys(s.accounts.google[0]).sort()).toEqual(['email', 'id', 'isPrimary', 'label', 'status']);
    delete tables.google_connection_status;
  });

  it('is an empty list when the user has no Google accounts or the view is missing', async () => {
    const s = await mod.getProviderState('uOld', 'orgNone');
    expect(s.accounts.google).toEqual([]);
    expect(s.accounts.microsoft).toEqual([]);
    expect(mod.EMPTY_ACCOUNTS).toEqual({ microsoft: [], google: [] });
  });
});

describe('Google files account preference', () => {
  it('is kept apart from the Microsoft one and clears', () => {
    localStorage.clear();
    mod.setFilesGoogleConnectionPreference('g2');
    expect(mod.getFilesGoogleConnectionPreference()).toBe('g2');
    expect(mod.getFilesConnectionPreference()).toBeNull();
    mod.setFilesConnectionPreference('c9');
    expect(mod.getFilesGoogleConnectionPreference()).toBe('g2');
    mod.setFilesGoogleConnectionPreference(null);
    expect(mod.getFilesGoogleConnectionPreference()).toBeNull();
    expect(mod.getFilesConnectionPreference()).toBe('c9');
    localStorage.clear();
  });
});
