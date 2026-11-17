import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Call { table?: string; op: string; args: unknown[] }
const calls: Call[] = [];
let results: Record<string, { data: unknown; error: { message: string; code?: string } | null }> = {};
const invoke = vi.fn();
const rpc = vi.fn();

/** A chainable, awaitable query stub: every method is recorded and the final await yields results[table]. */
function builder(table: string) {
  const q: Record<string, unknown> = {};
  const chain = (op: string) => (...args: unknown[]) => { calls.push({ table, op, args }); return q; };
  for (const op of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'in', 'order', 'limit']) q[op] = chain(op);
  q.maybeSingle = () => Promise.resolve(results[table] ?? { data: null, error: null });
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(results[table] ?? { data: [], error: null }).then(res, rej);
  return q;
}
vi.mock('../lib/supabase', () => ({ supabase: { from: (t: string) => builder(t), rpc: (...a: unknown[]) => rpc(...a), functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

const svc = await import('./caioAutomation');

beforeEach(() => { calls.length = 0; results = {}; invoke.mockReset(); rpc.mockReset(); });

describe('facts', () => {
  it('saves an owner-typed value as a confirmed fact with source user (upsert on engagement + key)', async () => {
    await svc.saveFact('org', 'eng', 'industry', '  Roofing  ');
    const c = calls.find((x) => x.op === 'upsert')!;
    expect(c.table).toBe('caio_facts');
    expect(c.args[0]).toMatchObject({ org_id: 'org', engagement_id: 'eng', fact_key: 'industry', value: 'Roofing', source: 'user', status: 'confirmed', evidence_quote: null });
    expect(c.args[1]).toEqual({ onConflict: 'engagement_id,fact_key' });
  });
  it('confirms through the RPC', async () => {
    rpc.mockResolvedValue({ error: null });
    await svc.confirmFact('f1');
    expect(rpc).toHaveBeenCalledWith('caio_confirm_fact', { p_id: 'f1', p_value: null });
  });
  it('shows trigger messages without the table prefix and hints at a missing migration', async () => {
    results.caio_facts = { data: null, error: { message: 'caio_facts: secret-like content: link to where it is stored instead' } };
    await expect(svc.saveFact('o', 'e', 'k', 'v')).rejects.toThrow('secret-like content: link to where it is stored instead');
    results.caio_facts = { data: null, error: { message: 'x', code: 'PGRST205' } };
    await expect(svc.listFacts('e')).rejects.toThrow(/migration 20261106100000/);
  });
});

describe('proposals', () => {
  it('accepts as extracted (null edit) or with the edited payload', async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    await svc.acceptProposal('p1');
    await svc.acceptProposal('p2', { value: 'Fixed' });
    expect(rpc).toHaveBeenNthCalledWith(1, 'caio_accept_proposal', { p_id: 'p1', p_edit: null });
    expect(rpc).toHaveBeenNthCalledWith(2, 'caio_accept_proposal', { p_id: 'p2', p_edit: { value: 'Fixed' } });
  });
  it('surfaces database validation errors and already-decided results', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'caio_records: Owner is required' } });
    await expect(svc.acceptProposal('p')).rejects.toThrow('Owner is required');
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'already_decided', status: 'rejected' }, error: null });
    await expect(svc.acceptProposal('p')).rejects.toThrow('already rejected');
  });
  it('rejects through the RPC', async () => {
    rpc.mockResolvedValue({ error: null });
    await svc.rejectProposal('p3');
    expect(rpc).toHaveBeenCalledWith('caio_reject_proposal', { p_id: 'p3' });
  });
  it('flattens the joined source', async () => {
    results.caio_proposals = { data: [{ id: 'p', source: [{ title: 'Call', kind: 'transcript' }] }], error: null };
    const [p] = await svc.listOpenProposals('e');
    expect(p.source).toEqual({ title: 'Call', kind: 'transcript' });
  });
});

describe('sources', () => {
  it('uploads multipart with the consent flag and every file', async () => {
    invoke.mockResolvedValue({ data: { ok: true, sources: [{ id: 's' }], skipped: [] }, error: null });
    const a = new File(['a'], 'a.txt'); const b = new File(['b'], 'b.vtt');
    await svc.uploadSources({ engagementId: 'eng', files: [a, b], kind: 'transcript', department: ' Ops ', consent: true });
    const [name, opts] = invoke.mock.calls[0] as [string, { body: FormData }];
    expect(name).toBe('caio-source-ingest');
    expect(opts.body.get('engagement_id')).toBe('eng');
    expect(opts.body.get('kind')).toBe('transcript');
    expect(opts.body.get('department')).toBe('Ops');
    expect(opts.body.get('interviewees')).toBeNull();
    expect(opts.body.get('consent')).toBe('true');
    expect(opts.body.getAll('files[]')).toHaveLength(2);
  });
  it('sends consent false when unticked', async () => {
    invoke.mockResolvedValue({ data: { ok: true, sources: [], skipped: [] }, error: null });
    await svc.uploadSources({ engagementId: 'e', files: [new File(['a'], 'a.md')], kind: 'summary', consent: false });
    expect(((invoke.mock.calls[0] as [string, { body: FormData }])[1]).body.get('consent')).toBe('false');
  });
  it('sends the JSON actions the function expects', async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
    await svc.allowSource('s1'); await svc.blockSource('s2'); await svc.ignoreMeeting('m1');
    await svc.linkMeeting('eng', 'm2', { consent: true, department: 'Sales' });
    expect(invoke.mock.calls.map((c) => (c as [string, { body: unknown }])[1].body)).toEqual([
      { action: 'allow-source', source_id: 's1' }, { action: 'block-source', source_id: 's2' }, { action: 'ignore-meeting', meeting_transcription_id: 'm1' },
      { action: 'link-meeting', engagement_id: 'eng', meeting_transcription_id: 'm2', consent: true, department: 'Sales' },
    ]);
  });
  it('reads the JSON error body of a failed call', async () => {
    const ctx = new Response(JSON.stringify({ error: 'Consent is required' }), { status: 400 });
    invoke.mockResolvedValue({ data: null, error: Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: ctx }) });
    await expect(svc.allowSource('s')).rejects.toThrow('Consent is required');
  });
  it('lists only meetings that are not linked or ignored', async () => {
    results.meeting_transcriptions = { data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], error: null };
    results.caio_meeting_links = { data: [{ meeting_transcription_id: 'm2' }], error: null };
    expect((await svc.listLinkableMeetings()).map((m) => m.id)).toEqual(['m1', 'm3']);
  });
});

describe('generation', () => {
  it('invokes caio-generate with the document for a regenerate', async () => {
    invoke.mockResolvedValue({ data: { ok: true, document_id: 'd', filled: 3, unresolved: [], needs_input: [] }, error: null });
    const r = await svc.generateDocument({ engagementId: 'e', templateNumber: 5, systemKey: 'SYS-0001', documentId: 'd' });
    expect(invoke).toHaveBeenCalledWith('caio-generate', { body: { engagement_id: 'e', template_number: 5, system_key: 'SYS-0001', document_id: 'd' } });
    expect(r.filled).toBe(3);
  });
  it('omits optional keys and explains an approved document', async () => {
    invoke.mockResolvedValue({ data: { ok: false, error: 'approved_use_revise' }, error: null });
    await expect(svc.generateDocument({ engagementId: 'e', templateNumber: 2 })).rejects.toThrow(/Revise it first/);
    expect((invoke.mock.calls[0] as [string, { body: object }])[1].body).toEqual({ engagement_id: 'e', template_number: 2 });
  });
});

describe('document fields, stale inputs and switch', () => {
  it('records a confirmed or edited mark for one document', async () => {
    await svc.setDocumentFieldStatus('d', 'INDUSTRY#2', 'edited', 'Roof repair');
    const upd = calls.find((c) => c.op === 'update')!;
    expect(upd.table).toBe('caio_document_fields');
    expect(upd.args[0]).toMatchObject({ status: 'edited', value: 'Roof repair' });
    expect(calls.filter((c) => c.op === 'eq').map((c) => c.args)).toEqual([['document_id', 'd'], ['mark_id', 'INDUSTRY#2']]);
  });
  it('finds the newest update across facts, records and sources', async () => {
    results.caio_facts = { data: [{ updated_at: '2026-11-01T00:00:00Z' }], error: null };
    results.caio_records = { data: [{ updated_at: '2026-11-03T00:00:00Z' }], error: null };
    results.caio_sources = { data: [], error: null };
    expect(await svc.latestInputUpdate('e')).toBe('2026-11-03T00:00:00Z');
  });
  it('maps generated_at by document', async () => {
    results.caio_documents = { data: [{ id: 'a', generated_at: 'x' }, { id: 'b', generated_at: null }], error: null };
    expect(await svc.listGeneratedAt('e')).toEqual({ a: 'x', b: null });
  });
  it('flips the automation switch', async () => {
    await svc.setAutomationEnabled('e', true);
    expect(calls.find((c) => c.op === 'update')!.args[0]).toEqual({ automation_enabled: true });
    results.caio_engagements = { data: { automation_enabled: true }, error: null };
    expect(await svc.getAutomationEnabled('e')).toBe(true);
  });
  it('dismisses and resolves input requests', async () => {
    await svc.dismissInputRequest('r');
    await svc.resolveInputRequest('r');
    const updates = calls.filter((c) => c.op === 'update').map((c) => c.args[0]);
    expect(updates[0]).toEqual({ status: 'dismissed' });
    expect(updates[1]).toMatchObject({ status: 'resolved' });
  });
});
