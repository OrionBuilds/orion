import { describe, expect, it } from 'vitest';
import { ENTITY_SPECS, type Row } from '../../../supabase/functions/_shared/system-health/crud-registry';
import {
  type CrudDb,
  type DbResult,
  runCrudSuite,
  sweepTagged,
  worstStatus,
} from '../../../supabase/functions/_shared/system-health/crud-runner';

/** In-memory tables shared by a "user" view and an "admin" view, with knobs to simulate failures. */
class Store {
  tables = new Map<string, Row[]>();
  seq = 0;
  rows(t: string): Row[] {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }
  total(): number {
    let n = 0;
    for (const r of this.tables.values()) n += r.length;
    return n;
  }
}

interface FakeOpts {
  failInsert?: Set<string>;
  /** Insert stores the row but reports an error (lost response). */
  loseInsertResponse?: Set<string>;
  denyDelete?: Set<string>;
  throwOnSelect?: Set<string>;
}

function fakeDb(store: Store, opts: FakeOpts = {}): CrudDb {
  const ok = <T,>(data: T | null): DbResult<T> => ({ data, error: null });
  return {
    async insert(table, row) {
      if (opts.failInsert?.has(table)) return { data: null, error: { message: `insert into ${table} refused` } };
      const stored = { id: `id-${++store.seq}`, created_at: new Date(Date.now() - 1000).toISOString(), timestamp: new Date().toISOString(), ...row };
      store.rows(table).push(stored);
      if (opts.loseInsertResponse?.has(table)) return { data: null, error: { message: 'network reset' } };
      return ok({ ...stored });
    },
    async selectById(table, id) {
      if (opts.throwOnSelect?.has(table)) throw new Error(`boom reading ${table}`);
      const r = store.rows(table).find((x) => x.id === id);
      return ok<Row>(r ? { ...r } : null);
    },
    async updateById(table, id, patch) {
      const r = store.rows(table).find((x) => x.id === id);
      if (!r) return ok<Row>(null);
      Object.assign(r, patch);
      return ok<Row>({ ...r });
    },
    async deleteById(table, id) {
      if (opts.denyDelete?.has(table)) return ok(0);
      const rows = store.rows(table);
      const i = rows.findIndex((x) => x.id === id);
      if (i < 0) return ok(0);
      rows.splice(i, 1);
      return ok(1);
    },
    async list(table) {
      return ok(store.rows(table).slice(0, 5));
    },
    async deleteTagged(table, orgColumn, orgId, tagColumn, prefix, createdBefore, createdColumn) {
      const rows = store.rows(table);
      const keep = rows.filter((r) => {
        const tagged = typeof r[tagColumn] === 'string' && (r[tagColumn] as string).startsWith(prefix);
        const inOrg = !orgColumn || r[orgColumn] === orgId;
        const old = !createdBefore || String(r[createdColumn ?? 'created_at']) < createdBefore;
        return !(tagged && inOrg && old);
      });
      const n = rows.length - keep.length;
      store.tables.set(table, keep);
      return ok(n);
    },
  };
}

function seedReal(store: Store) {
  store.rows('users').push({ id: 'u1', organization_id: 'org-1', email: 'a@x.com', role_id: 'r', status: 'active' });
  store.rows('roles').push({ id: 'r', name: 'SuperAdmin' });
  store.rows('contacts').push({ id: 'real-1', organization_id: 'org-1', first_name: 'Jane', last_name: 'Real' });
  store.rows('pipelines').push({ id: 'real-p', org_id: 'org-1', name: 'Sales' });
  store.rows('audit_logs').push({ id: 'real-a', organization_id: 'org-1', action: 'contact.update', timestamp: '2020-01-01' });
}

const base = { specs: ENTITY_SPECS, orgId: 'org-1', userId: 'u1', runId: 'run0000001' };

function snapshotReal(store: Store) {
  return JSON.stringify([
    store.rows('contacts').filter((r) => r.id === 'real-1'),
    store.rows('pipelines').filter((r) => r.id === 'real-p'),
    store.rows('audit_logs').filter((r) => r.id === 'real-a'),
  ]);
}

describe('runCrudSuite', () => {
  it('passes every entity in service mode and leaves no test rows behind', async () => {
    const store = new Store();
    seedReal(store);
    const before = store.total();
    const real = snapshotReal(store);
    const db = fakeDb(store);
    const { results, cleanup } = await runCrudSuite({ ...base, db, admin: db, mode: 'service' });

    const failing = results.filter((r) => r.status !== 'pass');
    expect(failing.map((f) => `${f.id}: ${f.error}`)).toEqual([]);
    expect(cleanup.status).toBe('pass');
    expect(store.total()).toBe(before);
    expect(snapshotReal(store)).toBe(real);

    const contacts = results.find((r) => r.id === 'crud.contacts')!;
    expect(contacts.steps!.map((s) => s.step)).toEqual(['create', 'read', 'update', 'audit', 'delete']);
    const proposals = results.find((r) => r.id === 'crud.proposals')!;
    expect(proposals.steps!.map((s) => s.step)).toContain('archive');
    expect(proposals.steps!.map((s) => s.step)).toContain('cleanup');
  });

  it('skips dependents of a failed insert and still cleans up everything else', async () => {
    const store = new Store();
    seedReal(store);
    const before = store.total();
    const db = fakeDb(store, { failInsert: new Set(['pipeline_stages']) });
    const { results, cleanup } = await runCrudSuite({ ...base, db, admin: db, mode: 'service' });

    const by = (k: string) => results.find((r) => r.id === `crud.${k}`)!;
    expect(by('pipeline_stages').status).toBe('fail');
    expect(by('pipeline_stages').error).toMatch(/refused/);
    expect(by('opportunities').status).toBe('skip');
    expect(by('opportunities').summary).toMatch(/pipeline_stages/);
    expect(by('contacts').status).toBe('pass');
    expect(cleanup.status).toBe('pass');
    expect(store.total()).toBe(before);
  });

  it('cleans up even when a step throws', async () => {
    const store = new Store();
    seedReal(store);
    const before = store.total();
    const db = fakeDb(store, { throwOnSelect: new Set(['projects']) });
    const admin = fakeDb(store);
    const { results, cleanup } = await runCrudSuite({ ...base, db, admin, mode: 'service' });
    expect(results.find((r) => r.id === 'crud.projects')!.status).toBe('fail');
    expect(cleanup.status).toBe('pass');
    expect(store.total()).toBe(before);
  });

  it('in RLS mode treats an expected policy refusal as a pass and removes the row with the service role', async () => {
    const store = new Store();
    seedReal(store);
    const before = store.total();
    const user = fakeDb(store, { denyDelete: new Set(['audit_logs', 'workflow_approval_queue', 'agent_task_runs']) });
    const admin = fakeDb(store);
    const { results, cleanup } = await runCrudSuite({ ...base, db: user, admin, mode: 'rls' });

    const audit = results.find((r) => r.id === 'crud.audit_logs')!;
    expect(audit.status).toBe('pass');
    expect(audit.steps!.find((s) => s.step === 'delete')!.message).toMatch(/refused by RLS/);
    expect(audit.steps!.find((s) => s.step === 'cleanup')!.status).toBe('pass');
    expect(cleanup.status).toBe('pass');
    expect(store.total()).toBe(before);
  });

  it('fails an entity when RLS unexpectedly blocks a delete the app relies on', async () => {
    const store = new Store();
    seedReal(store);
    const before = store.total();
    const user = fakeDb(store, { denyDelete: new Set(['contacts']) });
    const admin = fakeDb(store);
    const { results, cleanup } = await runCrudSuite({ ...base, selected: ['contacts'], db: user, admin, mode: 'rls' });
    const contacts = results.find((r) => r.id === 'crud.contacts')!;
    expect(contacts.status).toBe('fail');
    expect(contacts.error).toMatch(/0 rows deleted/);
    expect(cleanup.status).toBe('pass');
    expect(store.total()).toBe(before);
  });

  it('sweeps a row whose insert succeeded but whose response was lost', async () => {
    const store = new Store();
    seedReal(store);
    const before = store.total();
    const db = fakeDb(store, { loseInsertResponse: new Set(['documents']) });
    const { results, cleanup } = await runCrudSuite({ ...base, selected: ['documents'], db, admin: db, mode: 'service' });
    expect(results.find((r) => r.id === 'crud.documents')!.status).toBe('fail');
    expect(cleanup.status).toBe('pass');
    expect(store.total()).toBe(before);
  });

  it('runs only the selected entity and its dependencies', async () => {
    const store = new Store();
    const db = fakeDb(store);
    const { results } = await runCrudSuite({ ...base, selected: ['contact_notes'], db, admin: db, mode: 'service' });
    expect(results.map((r) => r.id)).toEqual(['crud.contacts', 'crud.contact_notes']);
  });
});

describe('sweepTagged', () => {
  it('refuses any prefix that is not a health-check tag', async () => {
    const store = new Store();
    seedReal(store);
    const before = store.total();
    const r = await sweepTagged(fakeDb(store), ENTITY_SPECS, 'org-1', 'Jane');
    expect(r.errors[0]).toMatch(/refused/);
    expect(store.total()).toBe(before);
  });

  it('removes stale tagged rows only in the caller org and only when old enough', async () => {
    const store = new Store();
    seedReal(store);
    store.rows('contacts').push(
      { id: 'old', organization_id: 'org-1', first_name: '[healthcheck] crashed', created_at: '2026-01-01T00:00:00Z' },
      { id: 'fresh', organization_id: 'org-1', first_name: '[healthcheck] in-flight', created_at: '2099-01-01T00:00:00Z' },
      { id: 'other-org', organization_id: 'org-2', first_name: '[healthcheck] theirs', created_at: '2026-01-01T00:00:00Z' },
    );
    const r = await sweepTagged(fakeDb(store), ENTITY_SPECS, 'org-1', '[healthcheck]', '2026-06-01T00:00:00Z');
    expect(r.deleted).toBe(1);
    expect(store.rows('contacts').map((c) => c.id).sort()).toEqual(['fresh', 'other-org', 'real-1']);
  });
});

describe('worstStatus', () => {
  it('ranks fail > warn > pass > skip', () => {
    expect(worstStatus(['pass', 'warn', 'skip'])).toBe('warn');
    expect(worstStatus(['pass', 'fail', 'warn'])).toBe('fail');
    expect(worstStatus([])).toBe('skip');
  });
});
