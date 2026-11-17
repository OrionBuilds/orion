import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'anon', accessToken: 'shared-token' },
}));
const rest = vi.hoisted(() => ({ restGet: vi.fn(), restPost: vi.fn(), restPatch: vi.fn(), restDelete: vi.fn(), restRpc: vi.fn() }));
vi.mock('../helpers/rest-client.js', () => rest);

import { globToRegExp, noteCoversFile, selectNotes, shapeIndexRow, sortNotes, registerProjectKnowledgeTools } from './project-knowledge.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers = new Map<string, Handler>();
registerProjectKnowledgeTools({ tool: (n: string, _d: string, _s: unknown, h: Handler) => { handlers.set(n, h); } } as never);
const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a);
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
const PID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { for (const f of Object.values(rest)) f.mockReset(); });

describe('glob matching', () => {
  it('handles *, ** and ?', () => {
    expect(globToRegExp('src/api/**').test('src/api/v1/users.ts')).toBe(true);
    expect(globToRegExp('src/api/*').test('src/api/v1/users.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('package.json').test('packageXjson')).toBe(false);
  });
  it('ignores leading ./ and /', () => {
    expect(noteCoversFile(['./src/**'], '/src/x.ts')).toBe(true);
    expect(noteCoversFile([], 'src/x.ts')).toBe(false);
    expect(noteCoversFile(null, 'src/x.ts')).toBe(false);
  });
});

describe('selection', () => {
  const rows = [
    { slug: 'web', kind: 'module', repo_url: 'r', covers: ['web/**'] },
    { slug: 'api', kind: 'module', repo_url: 'r', covers: ['api/**', 'shared/*.ts'] },
    { slug: 'overview', kind: 'overview', repo_url: 'r', covers: [] },
  ];
  it('returns each note once and reports unmatched files', () => {
    const r = selectNotes(rows, ['api'], ['api/x.ts', 'shared/y.ts', 'docs/readme.md']);
    expect(r.notes.map((n) => n.slug)).toEqual(['api']);
    expect(r.unmatched_files).toEqual(['docs/readme.md']);
  });
  it('orders overview first', () => {
    expect(sortNotes(rows).map((n) => n.slug)).toEqual(['overview', 'api', 'web']);
  });
  it('index rows carry body_bytes, not the body', () => {
    const s = shapeIndexRow({ slug: 'a', body: 'héllo' });
    expect(s.body).toBeUndefined();
    expect(s.body_bytes).toBe(6);
  });
});

describe('tools', () => {
  it('index returns notes without bodies plus sync', async () => {
    rest.restGet.mockImplementation(async (t: string) => t === 'project_knowledge'
      ? [{ slug: 'a', kind: 'module', repo_url: '', body: 'xx' }] : [{ repo_url: '', last_status: 'ok' }]);
    const out = parse(await call('project_knowledge_index', { project_id: PID }));
    expect(out.notes[0].body).toBeUndefined();
    expect(out.notes[0].body_bytes).toBe(2);
    expect(out.sync).toHaveLength(1);
  });
  it('get requires slugs or files', async () => {
    const r = await call('project_knowledge_get', { project_id: PID });
    expect(r.isError).toBe(true);
  });
  it('get does a reverse lookup by file', async () => {
    rest.restGet.mockResolvedValue([{ slug: 'api', kind: 'module', repo_url: '', covers: ['api/**'], body: 'B' }]);
    const out = parse(await call('project_knowledge_get', { project_id: PID, files: ['api/a.ts', 'z.ts'] }));
    expect(out.notes[0].body).toBe('B');
    expect(out.unmatched_files).toEqual(['z.ts']);
  });
  it('upsert maps to the RPC with defaults', async () => {
    rest.restRpc.mockResolvedValue({ id: 'n1', created: true, version: 1 });
    await call('project_knowledge_upsert', { project_id: PID, slug: 'api', kind: 'module', title: 'API', summary: 's', body: 'b' });
    expect(rest.restRpc).toHaveBeenCalledWith('project_knowledge_upsert', expect.objectContaining({
      p_repo_url: '', p_covers: [], p_depends_on: [], p_commit: null, p_clear_stale: true, p_slug: 'api' }));
  });
  it('sync_state sets set_error only when last_error is given', async () => {
    rest.restRpc.mockResolvedValue({});
    await call('project_knowledge_sync_state', { project_id: PID, acquire_lock_minutes: 30 });
    expect(rest.restRpc.mock.calls[0][1]).toMatchObject({ p_set_error: false, p_acquire_lock_minutes: 30 });
    await call('project_knowledge_sync_state', { project_id: PID, last_error: null });
    expect(rest.restRpc.mock.calls[1][1]).toMatchObject({ p_set_error: true, p_last_error: null });
  });
  it('surfaces RPC errors as tool errors', async () => {
    rest.restRpc.mockRejectedValue(new Error('secret-like content in a project note'));
    const r = await call('project_knowledge_upsert', { project_id: PID, slug: 'a', kind: 'module', title: 't', summary: 's', body: 'b' });
    expect(r.isError).toBe(true);
  });
});
