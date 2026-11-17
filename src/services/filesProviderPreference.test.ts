// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const prefs: Row[] = [];
let failReads = false;
let failWrites = false;

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'user_preferences') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_c: string, id: string) => ({
            maybeSingle: () => Promise.resolve(
              failReads
                ? { data: null, error: { message: 'column files_provider does not exist' } }
                : { data: prefs.find((r) => r.user_id === id) ?? null, error: null }
            ),
          }),
        }),
        upsert: (row: Row) => {
          if (failWrites) return Promise.resolve({ error: { message: 'boom' } });
          const i = prefs.findIndex((r) => r.user_id === row.user_id);
          if (i >= 0) prefs[i] = { ...prefs[i], ...row };
          else prefs.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  },
}));

const mod = await import('./connectedProvider');
const { buildDriveOptions } = await import('../hooks/useFilesProvider');

beforeEach(() => {
  prefs.length = 0;
  failReads = false;
  failWrites = false;
  localStorage.clear();
  mod.invalidateProviderCache();
});

describe('files provider preference', () => {
  it('saves to the user row and to this browser', async () => {
    await mod.saveFilesProviderPreference('u1', 'google');
    expect(prefs).toEqual([expect.objectContaining({ user_id: 'u1', files_provider: 'google' })]);
    expect(mod.getFilesProviderPreference()).toBe('google');
  });

  it('clearing the choice clears both', async () => {
    await mod.saveFilesProviderPreference('u1', 'google');
    await mod.saveFilesProviderPreference('u1', null);
    expect(prefs[0].files_provider).toBeNull();
    expect(mod.getFilesProviderPreference()).toBeNull();
  });

  it('still works in this browser when the save fails (e.g. migration pending)', async () => {
    failWrites = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mod.saveFilesProviderPreference('u1', 'microsoft');
    expect(mod.getFilesProviderPreference()).toBe('microsoft');
    warn.mockRestore();
  });

  it("loads the saved choice on a new browser", async () => {
    prefs.push({ user_id: 'u1', files_provider: 'google' });
    expect(mod.getFilesProviderPreference()).toBeNull();
    expect(await mod.loadFilesProviderPreference('u1')).toBe('google');
    expect(mod.getFilesProviderPreference()).toBe('google');
  });

  it('keeps this browser\'s choice when nothing is saved or the read fails', async () => {
    mod.setFilesProviderPreference('microsoft');
    expect(await mod.loadFilesProviderPreference('nobody')).toBe('microsoft');
    failReads = true;
    expect(await mod.loadFilesProviderPreference('u1')).toBe('microsoft');
  });

  it('ignores a saved value that is not a provider', async () => {
    prefs.push({ user_id: 'u1', files_provider: 'dropbox' });
    expect(await mod.loadFilesProviderPreference('u1')).toBeNull();
  });
});

describe('buildDriveOptions', () => {
  it('lists both drives, Microsoft first, with connection state and email', () => {
    expect(buildDriveOptions(['google'], { google: 'a@gmail.com' })).toEqual([
      { provider: 'microsoft', connected: false, email: null },
      { provider: 'google', connected: true, email: 'a@gmail.com' },
    ]);
  });

  it('marks both connected when both are', () => {
    const o = buildDriveOptions(['microsoft', 'google'], {});
    expect(o.every((x) => x.connected)).toBe(true);
  });

  it('shows both unconnected for a user with neither', () => {
    expect(buildDriveOptions([], {}).map((x) => x.connected)).toEqual([false, false]);
  });
});
