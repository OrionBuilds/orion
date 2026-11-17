import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'anon', accessToken: 'shared-token' },
}));
vi.mock('../helpers/edge-client.js', () => ({ callEdgeFunction: vi.fn() }));

import { registerComplianceTools } from './compliance.js';
import { runWithAuth } from '../helpers/auth-context.js';

// ── Tool handlers against a fake PostgREST ──────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers = new Map<string, Handler>();
registerComplianceTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => { handlers.set(name, handler); },
} as never);

const fetchMock = vi.fn();
type Route = (url: URL, init: RequestInit) => unknown;
let routes: Array<{ method: string; path: RegExp; handle: Route }> = [];
const calls: Array<{ method: string; url: string; body: unknown }> = [];

function respond(data: unknown, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  routes = [];
  calls.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: u.pathname + u.search, body });
    if (u.pathname.endsWith('/rpc/agent_whoami')) return respond({ user_id: 'u1', organization_id: 'org1', email: 'clara@example.com', agent_slug: 'clara' });
    const r = routes.find((x) => x.method === method && x.path.test(u.pathname));
    if (!r) return respond({ message: `no fake route for ${method} ${u.pathname}` }, 500);
    return respond(r.handle(u, init));
  });
  vi.stubGlobal('fetch', fetchMock);
});

const on = (method: string, path: RegExp, handle: Route) => routes.push({ method, path, handle });
const run = (name: string, args: Record<string, unknown>) => runWithAuth('jwt', () => handlers.get(name)!(args));
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.startsWith(path));

const CID = '11111111-1111-4111-8111-111111111111';
const CID2 = '22222222-2222-4222-8222-222222222222';

describe('suppressions_check', () => {
  it('passes the recipient through to the RPC and returns the union verdict', async () => {
    on('POST', /\/rpc\/suppression_check$/, () => ({ blocked: true, hits: [{ kind: 'phone', reason: 'stop_keyword', source: 'dnc_numbers' }, { kind: 'domain', reason: 'mega_domain', source: 'system' }] }));
    const out = parse(await run('suppressions_check', { channel: 'sms', phone: '813-555-0199', email: 'joe@megacorp.com' }));
    expect(out.blocked).toBe(true);
    expect(out.hits.map((h: { kind: string }) => h.kind)).toEqual(['phone', 'domain']);
    expect(sent('POST', '/rest/v1/rpc/suppression_check')[0].body).toMatchObject({ p_channel: 'sms', p_phone: '813-555-0199', p_email: 'joe@megacorp.com' });
  });
});

describe('tracked_links_create', () => {
  it('mints a 12-hex-char slug and posts the row with it', async () => {
    on('POST', /\/tracked_links$/, (_u, init) => [{ id: 'link1', ...JSON.parse(String(init.body)) }]);
    const out = parse(await run('tracked_links_create', { destination_url: 'https://example.com', contact_id: CID, metadata: { kind: 'unsubscribe', enrollment_id: CID2 } }));
    expect(out.slug).toMatch(/^[0-9a-f]{12}$/);
    const body = sent('POST', '/rest/v1/tracked_links')[0].body as { slug: string; org_id: string; contact_id: string };
    expect(body.slug).toBe(out.slug);
    expect(body.org_id).toBe('org1');
    expect(body.contact_id).toBe(CID);
    expect(out.link.id).toBe('link1');
  });
});

describe('consents_list', () => {
  it('treats ebr as insufficient for SMS but any live consent as enough for email', async () => {
    on('GET', /\/contact_consents$/, () => [
      { channel: 'sms', basis: 'ebr', expires_at: null },
      { channel: 'email', basis: 'b2b_email', expires_at: null },
      { channel: 'voice', basis: 'express_oral', expires_at: '2000-01-01T00:00:00Z' },
    ]);
    const out = parse(await run('consents_list', { contact_id: CID }));
    expect(out).toMatchObject({ sms_ok: false, email_ok: true, voice_ok: false });
    expect(out.consents).toHaveLength(2);
  });
});
