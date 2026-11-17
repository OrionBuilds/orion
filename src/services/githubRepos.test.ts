import { describe, expect, it } from 'vitest';
import { filterRepos, type GithubRepo } from '../../supabase/functions/_shared/github';

const repo = (full_name: string, pushed_at: string, extra: Partial<GithubRepo> = {}): GithubRepo => ({
  full_name, html_url: `https://github.com/${full_name}`, private: true, description: null, pushed_at, owner: { login: full_name.split('/')[0] }, ...extra,
});

const repos = [
  repo('jordan-dev/friday', '2026-10-28T10:00:00Z', { permissions: { admin: true } }),
  repo('acme-org/acme-api', '2026-10-27T10:00:00Z', { permissions: { push: true } }),
  repo('jexample/client-dashboard', '2026-10-20T10:00:00Z', { description: 'Globex client planner', permissions: { pull: true } }),
  repo('jordan-dev/friday', '2026-10-28T10:00:00Z'),
];

describe('filterRepos (github-api)', () => {
  it('matches every term on owner/name or description, case-insensitive', () => {
    expect(filterRepos(repos, 'acme').map((r) => r.full_name)).toEqual(['acme-org/acme-api']);
    expect(filterRepos(repos, 'globex planner').map((r) => r.full_name)).toEqual(['jexample/client-dashboard']);
    expect(filterRepos(repos, 'friday nope')).toEqual([]);
  });

  it('returns the most recently pushed first, de-duplicated, with the caller role', () => {
    const all = filterRepos(repos, '');
    expect(all.map((r) => r.full_name)).toEqual([
      'jordan-dev/friday', 'acme-org/acme-api', 'jexample/client-dashboard',
    ]);
    expect(all.map((r) => r.role)).toEqual(['owner', 'write', 'read']);
    expect(all[0].url).toBe('https://github.com/jordan-dev/friday');
  });

  it('caps the result size', () => {
    expect(filterRepos(repos, '', 2)).toHaveLength(2);
  });
});
