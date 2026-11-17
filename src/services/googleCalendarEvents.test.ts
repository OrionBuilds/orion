// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const calls: { slug: string; body: Record<string, unknown> }[] = [];
let googleAccounts: { id: string; email: string }[] = [];
let failFor: string | null = null;

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let single = false;
  const run = () => {
    const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    return { data: single ? rows[0] ?? null : rows, error: null, count: rows.length };
  };
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
    limit: () => q,
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
  };
  return q;
}

vi.mock('../lib/supabase', () => ({ supabase: { from: (t: string) => query(t) } }));
vi.mock('../lib/edgeFunction', () => ({
  callEdgeFunction: (slug: string, body: Record<string, unknown>) => {
    calls.push({ slug, body });
    if (failFor && body.connection_id === failFor) {
      return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'needs reconnect' }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { synced: 2, processed: 3 } }) });
  },
  parseEdgeFunctionError: (err: { error?: string }, fallback: string) => err.error ?? fallback,
}));
vi.mock('./connectedProvider', () => ({
  getMyProviderState: () => Promise.resolve({
    connected: ['google'],
    accounts: { microsoft: [], google: googleAccounts.map((a, i) => ({ ...a, label: null, isPrimary: i === 0, status: 'active' })) },
  }),
}));

const mod = await import('./googleCalendarEvents');

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  calls.length = 0;
  googleAccounts = [];
  failFor = null;
});

describe('event actions carry connection_id only when given', () => {
  it('update, delete and rsvp are unchanged without an account', async () => {
    await mod.updateGoogleCalendarEvent('e1', { summary: 'x' }, 'google');
    await mod.deleteGoogleCalendarEvent('e1', 'google');
    await mod.rsvpGoogleCalendarEvent('e1', 'accepted', 'google');
    expect(calls.map((c) => c.body)).toEqual([
      { action: 'update-event', eventId: 'e1', updates: { summary: 'x' } },
      { action: 'delete-event', eventId: 'e1' },
      { action: 'rsvp', eventId: 'e1', response: 'accepted' },
    ]);
    expect(calls.every((c) => c.slug === 'google-calendar-sync')).toBe(true);
  });

  it('sends connection_id for a chosen Google account', async () => {
    await mod.updateGoogleCalendarEvent('e1', { summary: 'x' }, 'google', 'g2');
    await mod.deleteGoogleCalendarEvent('e1', 'google', 'g2');
    await mod.rsvpGoogleCalendarEvent('e1', 'declined', 'google', 'g2');
    expect(calls.map((c) => c.body.connection_id)).toEqual(['g2', 'g2', 'g2']);
  });

  it('never sends a Google connection id to Microsoft calendar actions', async () => {
    tables.microsoft_calendar_events = [{ id: 'm1', graph_event_id: 'graph-1' }];
    await mod.deleteGoogleCalendarEvent('m1', 'microsoft', 'g2');
    expect(calls[0].slug).toBe('microsoft-calendar');
    expect(calls[0].body).toEqual({ action: 'delete-event', eventId: 'graph-1' });
  });
});

describe('sync across accounts', () => {
  it('a single Google account syncs once, with no connection_id (as before)', async () => {
    googleAccounts = [{ id: 'g1', email: 'a@x.com' }];
    const out = await mod.syncGoogleCalendar();
    expect(calls).toEqual([{ slug: 'google-calendar-sync', body: { action: 'sync' } }]);
    expect(out).toEqual({ synced: 2, errors: undefined });
  });

  it('two accounts sync once each and the counts add up', async () => {
    googleAccounts = [{ id: 'g1', email: 'a@x.com' }, { id: 'g2', email: 'b@x.com' }];
    const out = await mod.syncGoogleCalendar();
    expect(calls.map((c) => c.body)).toEqual([
      { action: 'sync', connection_id: 'g1' },
      { action: 'sync', connection_id: 'g2' },
    ]);
    expect(out.synced).toBe(4);
  });

  it('one failing account does not hide the other, and is reported', async () => {
    googleAccounts = [{ id: 'g1', email: 'a@x.com' }, { id: 'g2', email: 'b@x.com' }];
    failFor = 'g2';
    const out = await mod.triggerIncrementalSync();
    expect(out.processed).toBe(3);
    expect(out.errors).toEqual(['b@x.com: needs reconnect']);
  });

  it('merges per-account results, tolerating bare and wrapped shapes', () => {
    expect(mod.mergeSyncResults([{ synced: 1 }, { data: { synced: 2, errors: ['x'] } }], 'synced')).toEqual({ count: 3, errors: ['x'] });
    expect(mod.mergeSyncResults([{ synced: 5 }], 'processed')).toEqual({ count: 5, errors: [] });
  });
});

describe('sync status across Google accounts', () => {
  it('is disconnected with no calendar connections', () => {
    expect(mod.combineGoogleSyncRows([], 0)).toMatchObject({ provider: 'google', connected: false, syncEnabled: false, pendingJobs: 0 });
  });

  it('combines several accounts: any enabled, latest sync times, summed jobs', () => {
    const out = mod.combineGoogleSyncRows([
      { id: 'a', sync_enabled: false, last_full_sync_at: '2026-11-01T00:00:00Z', last_incremental_sync_at: null },
      { id: 'b', sync_enabled: true, last_full_sync_at: '2026-11-03T00:00:00Z', last_incremental_sync_at: '2026-11-04T00:00:00Z' },
    ], 3);
    expect(out).toMatchObject({ connected: true, syncEnabled: true, lastFullSync: '2026-11-03T00:00:00Z', lastIncrementalSync: '2026-11-04T00:00:00Z', pendingJobs: 3 });
  });

  it('getSyncStatus reads every calendar connection of the user (no single-row read)', async () => {
    tables.google_calendar_connections = [
      { id: 'a', user_id: 'u1', sync_enabled: true, last_full_sync_at: null, last_incremental_sync_at: null },
      { id: 'b', user_id: 'u1', sync_enabled: false, last_full_sync_at: null, last_incremental_sync_at: null },
    ];
    tables.google_calendar_sync_jobs = [
      { id: 'j1', connection_id: 'a', status: 'queued' },
      { id: 'j2', connection_id: 'b', status: 'processing' },
      { id: 'j3', connection_id: 'b', status: 'done' },
    ];
    const s = await mod.getSyncStatus('u1');
    expect(s.connected).toBe(true);
    expect(s.pendingJobs).toBe(2);
    expect(s.providers.map((p) => p.provider)).toEqual(['google']);
  });
});
