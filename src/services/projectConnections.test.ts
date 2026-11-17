import { describe, expect, it } from 'vitest';
import { folderFields, normalizeGithubRepo, normalizeSiteUrl, parseSupabaseRef, repoLabel } from './projectConnections';

describe('normalizeGithubRepo', () => {
  it('accepts owner/repo, URLs, .git and SSH remotes', () => {
    expect(normalizeGithubRepo('jordan-dev/friday')).toBe('https://github.com/jordan-dev/friday');
    expect(normalizeGithubRepo('https://github.com/acme-org/orion.git')).toBe('https://github.com/acme-org/orion');
    expect(normalizeGithubRepo('github.com/acme-org/mcp-server/tree/main/src')).toBe('https://github.com/acme-org/mcp-server');
    expect(normalizeGithubRepo('git@github.com:jexample/client-dashboard.git'))
      .toBe('https://github.com/jexample/client-dashboard');
  });

  it('rejects anything that is not a GitHub repo', () => {
    expect(normalizeGithubRepo('https://gitlab.com/a/b')).toBeNull();
    expect(normalizeGithubRepo('just-a-name')).toBeNull();
    expect(normalizeGithubRepo('')).toBeNull();
  });

  it('labels repos without the host', () => {
    expect(repoLabel('https://github.com/jordan-dev/friday')).toBe('jordan-dev/friday');
  });
});

describe('parseSupabaseRef', () => {
  it('reads a bare ref, an API URL or a dashboard URL', () => {
    expect(parseSupabaseRef('abcdefghijklmnopqrst')).toBe('abcdefghijklmnopqrst');
    expect(parseSupabaseRef('https://abcdefghijklmnopqrst.supabase.co')).toBe('abcdefghijklmnopqrst');
    expect(parseSupabaseRef('https://supabase.com/dashboard/project/zyxwvutsrqponmlkjihg/editor')).toBe('zyxwvutsrqponmlkjihg');
  });

  it('rejects anything else', () => {
    expect(parseSupabaseRef('abc')).toBeNull();
    expect(parseSupabaseRef('https://example.com')).toBeNull();
  });
});

describe('normalizeSiteUrl', () => {
  it('adds https and drops a trailing slash', () => {
    expect(normalizeSiteUrl('pestcoweeds.com')).toBe('https://pestcoweeds.com');
    expect(normalizeSiteUrl('https://globex-cap.netlify.app/')).toBe('https://globex-cap.netlify.app');
  });

  it('rejects things that are not addresses', () => {
    expect(normalizeSiteUrl('localhost')).toBeNull();
    expect(normalizeSiteUrl('   ')).toBeNull();
  });
});

describe('folderFields', () => {
  it('fills every files column, or clears them all together', () => {
    expect(folderFields({ provider: 'microsoft', driveId: 'b!x', id: '01ABC', name: 'OneDrive / Clients', url: 'https://x' })).toEqual({
      files_provider: 'microsoft', files_drive_id: 'b!x', files_folder_id: '01ABC', files_folder_name: 'OneDrive / Clients', files_folder_url: 'https://x',
    });
    expect(Object.values(folderFields(null)).every((v) => v === null)).toBe(true);
  });
});
