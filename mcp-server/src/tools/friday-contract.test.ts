import { describe, it, expect, vi, beforeEach } from 'vitest';

// FRIDAY fix contract (OS side): pure helpers + the write shapes agents depend on.
vi.mock('../config.js', () => ({
  config: { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'anon', accessToken: 'shared-token' },
}));
const rest = vi.hoisted(() => ({
  restGet: vi.fn(),
  restPost: vi.fn(),
  restPatch: vi.fn(),
  restDelete: vi.fn(),
  restRpc: vi.fn(),
}));
vi.mock('../helpers/rest-client.js', () => rest);
const edge = vi.hoisted(() => ({ callEdgeFunction: vi.fn(), callEdgeRoute: vi.fn() }));
vi.mock('../helpers/edge-client.js', () => edge);

import { shapeReview, isUniqueViolation, registerClientReviewsTools } from './client-reviews.js';
import { projectTaskBody } from './projects.js';
import { registerAgentApprovalsTools } from './agent-approvals.js';
import { registerContactsTools } from './contacts.js';
import { registerAgentCodeRunsTools } from './agent-code-runs.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers = new Map<string, Handler>();
const fakeServer = { tool: (name: string, _d: string, _s: unknown, h: Handler) => { handlers.set(name, h); } } as never;
registerClientReviewsTools(fakeServer);
registerAgentApprovalsTools(fakeServer);
registerContactsTools(fakeServer);
registerAgentCodeRunsTools(fakeServer);

const WHO = { user_id: 'u-friday', organization_id: 'org-1', email: 'friday@x.test', name: 'FRIDAY', role: 'FridayAgent', agent_slug: 'friday' };
const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

beforeEach(() => {
  for (const f of Object.values(rest)) f.mockReset();
  edge.callEdgeFunction.mockReset();
  rest.restRpc.mockImplementation(async (fn: string) => (fn === 'agent_whoami' ? [WHO] : { id: 'run-1' }));
});

describe('shapeReview', () => {
  it('orders comments and labels authors', () => {
    const out = shapeReview({
      id: 'r1', status: 'pending',
      client_review_comments: [
        { author_type: 'agent', author_name: null, body: 'second', created_at: '2026-10-29T02:00:00Z' },
        { author_type: 'client', author_name: 'Pat', body: 'first', created_at: '2026-10-29T01:00:00Z' },
      ],
    });
    expect(out).not.toHaveProperty('client_review_comments');
    expect(out.comments).toEqual([
      { author: 'Pat', author_type: 'client', body: 'first', created_at: '2026-10-29T01:00:00Z' },
      { author: 'Agent', author_type: 'agent', body: 'second', created_at: '2026-10-29T02:00:00Z' },
    ]);
  });
  it('detects unique violations', () => {
    expect(isUniqueViolation(new Error('API Error 409: duplicate key value violates unique constraint'))).toBe(true);
    expect(isUniqueViolation(new Error('API Error 400: bad'))).toBe(false);
  });
});

describe('projectTaskBody', () => {
  it('maps the deprecated assigned_to alias onto assigned_user_id', () => {
    expect(projectTaskBody({ title: 't', assigned_to: 'u1' })).toEqual({ title: 't', assigned_user_id: 'u1' });
    expect(projectTaskBody({ assigned_to: 'u1', assigned_user_id: 'u2' })).toEqual({ assigned_user_id: 'u2' });
  });
  it('stamps completed_at on completed and clears it on reopen', () => {
    expect(projectTaskBody({ status: 'completed' }, 'NOW')).toEqual({ status: 'completed', completed_at: 'NOW' });
    expect(projectTaskBody({ status: 'todo' }, 'NOW')).toEqual({ status: 'todo', completed_at: null });
    expect(projectTaskBody({ title: 'x' }, 'NOW')).toEqual({ title: 'x' });
  });
});

describe('client_reviews_create', () => {
  it('is idempotent: an existing (project, ref, round) is returned, never re-inserted', async () => {
    rest.restGet.mockResolvedValueOnce([{ id: 'rev-1', status: 'pending' }]);
    edge.callEdgeFunction.mockResolvedValue({ portal_url: 'https://os.test/client-portal/projects/p1', notified: false, notify_reason: 'already_notified' });
    const r = parse(await call('client_reviews_create', { project_id: 'p1', request_ref: 'req-9', title: 'T', summary: 'S', notify: true }));
    expect(rest.restPost).not.toHaveBeenCalled();
    expect(r).toMatchObject({ id: 'rev-1', created: false, notified: false, portal_url: 'https://os.test/client-portal/projects/p1' });
    expect(edge.callEdgeFunction).toHaveBeenCalledWith('client-review-notify', { review_id: 'rev-1', send: true });
  });
  it('creates round 1 by default and reports a failed notice instead of throwing', async () => {
    rest.restGet.mockResolvedValueOnce([]);
    rest.restPost.mockResolvedValueOnce([{ id: 'rev-2', status: 'pending' }]);
    edge.callEdgeFunction.mockRejectedValue(new Error('boom'));
    const r = parse(await call('client_reviews_create', { project_id: 'p1', request_ref: 'req-9', title: 'T', summary: 'S', notify: true }));
    expect(rest.restPost.mock.calls[0][1]).toMatchObject({ org_id: 'org-1', round: 1, created_by: 'u-friday' });
    expect(r).toMatchObject({ id: 'rev-2', created: true, notified: false });
    expect(r.notify_reason).toMatch(/notify_failed: boom/);
  });
  it('recovers from an insert race by re-reading', async () => {
    rest.restGet.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'rev-3', status: 'pending' }]);
    rest.restPost.mockRejectedValueOnce(new Error('API Error 409: duplicate key value'));
    edge.callEdgeFunction.mockResolvedValue({ portal_url: 'u', notified: false });
    const r = parse(await call('client_reviews_create', { project_id: 'p1', request_ref: 'r', title: 'T', summary: 'S', notify: false }));
    expect(r).toMatchObject({ id: 'rev-3', created: false });
  });
});

describe('client_reviews_update', () => {
  it('surfaces an illegal transition from the DB trigger', async () => {
    rest.restGet.mockResolvedValueOnce([{ id: 'r', org_id: 'org-1', status: 'closed' }]);
    rest.restPatch.mockRejectedValueOnce(new Error('API Error 400: client review cannot go from closed to superseded'));
    const r = await call('client_reviews_update', { id: 'r', status: 'superseded' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Invalid transition/);
  });
});

describe('agent_approval_mirror', () => {
  it('creates the queue row with the principal in draft_content and inserts NO notification itself', async () => {
    rest.restGet.mockResolvedValueOnce([]); // no existing row
    rest.restPost.mockResolvedValueOnce([{ id: 'a1', status: 'pending_approval' }]);
    const r = parse(await call('agent_approval_mirror', { agent_slug: 'friday', external_ref: 'ask-1', title: 'Merge #7', principal_user_id: 'owner-1', expires_at: '2099-01-01T00:00:00Z' }));
    expect(rest.restPost).toHaveBeenCalledTimes(1);
    const [table, body] = rest.restPost.mock.calls[0];
    expect(table).toBe('workflow_approval_queue');
    expect(body).not.toHaveProperty('expires_at');
    expect(body.draft_content.principal_user_id).toBe('owner-1');
    expect(r).toMatchObject({ created: true, notified_by: 'os' });
  });
});

describe('contacts', () => {
  it('persists job title and address fields on update', async () => {
    rest.restPatch.mockResolvedValueOnce([{ id: 'c1' }]);
    await call('contacts_update', { id: 'c1', job_title: 'CTO', address_line1: '1 Main', city: 'Tampa', state: 'FL', postal_code: '33601' });
    expect(rest.restPatch.mock.calls[0][2]).toEqual({ job_title: 'CTO', address_line1: '1 Main', city: 'Tampa', state: 'FL', postal_code: '33601' });
  });
  it('rejects the non-existent type field explicitly', async () => {
    const r = await call('contacts_update', { id: 'c1', type: 'company' });
    expect(r.isError).toBe(true);
    expect(rest.restPatch).not.toHaveBeenCalled();
  });
});

describe('agent_code_runs_report', () => {
  it('passes every field to the RPC', async () => {
    const r = parse(await call('agent_code_runs_report', { external_id: 'run-x', kind: 'fix', status: 'succeeded', started_at: '2026-10-29T00:00:00Z', pr_url: 'https://github.com/o/r/pull/1' }));
    expect(r).toEqual({ id: 'run-1' });
    expect(rest.restRpc).toHaveBeenCalledWith('agent_code_run_report', expect.objectContaining({
      p_external_id: 'run-x', p_kind: 'fix', p_status: 'succeeded', p_pr_url: 'https://github.com/o/r/pull/1', p_project_id: null,
    }));
  });
});
