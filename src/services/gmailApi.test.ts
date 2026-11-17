// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let viewError: { message: string } | null = null;
const calls: { slug: string; body: Record<string, unknown> }[] = [];
const deletes: { table: string; filters: Record<string, unknown> }[] = [];

function query(table: string) {
  const filters: Record<string, unknown> = {};
  let mode: 'select' | 'delete' = 'select';
  const run = () => {
    if (table === 'google_connection_status' && viewError) return { data: null, error: viewError };
    if (mode === 'delete') {
      deletes.push({ table, filters: { ...filters } });
      return { data: null, error: null };
    }
    const rows = (tables[table] || []).filter((r) => Object.entries(filters).every(([c, v]) => r[c] === v));
    return { data: rows, error: null };
  };
  const q: Record<string, unknown> = {
    select: () => q,
    delete: () => { mode = 'delete'; return q; },
    update: () => q,
    eq: (c: string, v: unknown) => { filters[c] = v; return q; },
    maybeSingle: () => Promise.resolve({ data: (run().data as Row[] | null)?.[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
  };
  return q;
}

vi.mock('../lib/supabase', () => ({ supabase: { from: (t: string) => query(t) } }));
vi.mock('../lib/edgeFunction', () => ({
  callEdgeFunction: (slug: string, body: Record<string, unknown>) => {
    calls.push({ slug, body });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}), blob: () => Promise.resolve(new Blob()) });
  },
  parseEdgeFunctionError: (_e: unknown, fallback: string) => fallback,
}));

const mod = await import('./gmailApi');

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  viewError = null;
  calls.length = 0;
  deletes.length = 0;
});

describe('send and reply carry from_connection_id only when chosen', () => {
  it('omits it for single-account callers', async () => {
    await mod.sendGmailEmail({ to: 'a@x.com', subject: 's', htmlBody: 'b' });
    await mod.replyToGmailThread({ to: 'a@x.com', htmlBody: 'b', threadId: 't1' });
    expect(calls[0].body).toEqual({ action: 'send', to: 'a@x.com', subject: 's', htmlBody: 'b' });
    expect(calls[1].body).toEqual({ action: 'reply', to: 'a@x.com', htmlBody: 'b', threadId: 't1' });
  });

  it('sends from_connection_id and never the camelCase name', async () => {
    await mod.sendGmailEmail({ to: 'a@x.com', subject: 's', htmlBody: 'b', fromConnectionId: 'g2' });
    await mod.replyToGmailThread({ to: 'a@x.com', htmlBody: 'b', threadId: 't1', fromConnectionId: 'g2' });
    expect(calls[0].body).toMatchObject({ action: 'send', from_connection_id: 'g2' });
    expect(calls[1].body).toMatchObject({ action: 'reply', from_connection_id: 'g2' });
    expect(calls[0].body).not.toHaveProperty('fromConnectionId');
    expect(calls[1].body).not.toHaveProperty('fromConnectionId');
  });
});

describe('other actions accept connection_id', () => {
  it('adds connection_id only when given', async () => {
    await mod.getGmailThread('t1');
    await mod.getGmailThread('t1', 'g2');
    await mod.createGmailDraft({ to: 'a@x.com', connectionId: 'g2' });
    await mod.updateGmailDraft({ draftId: 'd1' });
    await mod.deleteGmailDraft('d1', 'g2');
    await mod.trashGmailMessage('m1', 'g2');
    await mod.modifyGmailLabels('m1', ['A'], undefined, 'g2');
    await mod.downloadAttachment('m1', 'a1', 'g2');
    expect(calls[0].body).toEqual({ action: 'get-thread', threadId: 't1' });
    expect(calls[1].body).toEqual({ action: 'get-thread', threadId: 't1', connection_id: 'g2' });
    expect(calls[2].body).toEqual({ action: 'create-draft', to: 'a@x.com', connection_id: 'g2' });
    expect(calls[3].body).toEqual({ action: 'update-draft', draftId: 'd1' });
    expect(calls[4].body).toEqual({ action: 'delete-draft', draftId: 'd1', connection_id: 'g2' });
    expect(calls[5].body).toMatchObject({ action: 'trash', connection_id: 'g2' });
    expect(calls[6].body).toMatchObject({ action: 'modify-labels', connection_id: 'g2' });
    expect(calls[7].body).toMatchObject({ action: 'get-attachment', connection_id: 'g2' });
  });
});

describe('getGmailConnectionStatus', () => {
  beforeEach(() => {
    tables.users = [{ id: 'u1', gmail_connected: true, organization_id: 'o1' }, { id: 'u0', gmail_connected: false, organization_id: 'o1' }];
  });

  it('is not connected when the user flag is off', async () => {
    expect(await mod.getGmailConnectionStatus('u0')).toEqual({ connected: false, email: null, lastSyncAt: null, syncStatus: null });
  });

  it('reports the primary account from the status view (two accounts, no single-row read)', async () => {
    tables.google_connection_status = [
      { connection_id: 'g2', email: 'sales@corp.com', is_primary: false, last_incremental_sync_at: '2026-11-05T08:00:00Z', sync_status: 'idle' },
      { connection_id: 'g1', email: 'jordan@gmail.com', is_primary: true, last_incremental_sync_at: '2026-11-05T09:00:00Z', sync_status: 'syncing' },
    ];
    expect(await mod.getGmailConnectionStatus('u1')).toEqual({
      connected: true, email: 'jordan@gmail.com', lastSyncAt: '2026-11-05T09:00:00Z', syncStatus: 'syncing',
    });
  });

  it('reports the requested account when a connection id is given', async () => {
    tables.google_connection_status = [
      { connection_id: 'g2', email: 'sales@corp.com', is_primary: false, last_incremental_sync_at: null, sync_status: 'idle' },
      { connection_id: 'g1', email: 'jordan@gmail.com', is_primary: true, last_incremental_sync_at: null, sync_status: null },
    ];
    expect((await mod.getGmailConnectionStatus('u1', 'g2')).email).toBe('sales@corp.com');
    expect((await mod.getGmailConnectionStatus('u1', 'unknown')).email).toBe('jordan@gmail.com');
  });

  it('falls back to the legacy per-user rows when the view is unavailable', async () => {
    viewError = { message: 'relation does not exist' };
    tables.gmail_oauth_tokens = [{ user_id: 'u1', organization_id: 'o1', email: 'old@gmail.com' }];
    tables.gmail_sync_state = [{ user_id: 'u1', organization_id: 'o1', last_incremental_sync_at: '2026-11-01T00:00:00Z', sync_status: 'idle' }];
    expect(await mod.getGmailConnectionStatus('u1')).toEqual({
      connected: true, email: 'old@gmail.com', lastSyncAt: '2026-11-01T00:00:00Z', syncStatus: 'idle',
    });
  });
});

describe('disconnectGmail', () => {
  beforeEach(() => { tables.users = [{ id: 'u1', gmail_connected: true, organization_id: 'o1' }]; });

  it('with a connection id deletes only that account\'s rows and leaves the mirror to the server', async () => {
    await mod.disconnectGmail('u1', 'g2');
    expect(deletes).toEqual([
      { table: 'gmail_oauth_tokens', filters: { organization_id: 'o1', user_id: 'u1', connection_id: 'g2' } },
      { table: 'gmail_sync_state', filters: { organization_id: 'o1', user_id: 'u1', connection_id: 'g2' } },
    ]);
  });

  it('without an id keeps the old whole-user behaviour', async () => {
    await mod.disconnectGmail('u1');
    expect(deletes.map((d) => d.table)).toEqual(['gmail_oauth_tokens', 'gmail_sync_state', 'user_connected_accounts']);
    expect(deletes[0].filters).not.toHaveProperty('connection_id');
  });
});
