import { describe, expect, it } from 'vitest';
import { DASHBOARD_START_PAGE, getStartPageOptions, resolveStartPage, type CanOpenNavEntry } from './startPage';

const all: CanOpenNavEntry = () => true;

describe('getStartPageOptions', () => {
  it('offers the dashboard plus every sidebar module, with tabbed modules as their tabs', () => {
    const paths = getStartPageOptions(all).map((o) => o.path);
    expect(paths[0]).toBe(DASHBOARD_START_PAGE);
    expect(paths).toEqual(expect.arrayContaining(['/conversations', '/calendars', '/contacts', '/proposals', '/contracts', '/settings']));
    expect(paths).not.toContain('/documents');
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('drops modules the user cannot open', () => {
    const noContacts: CanOpenNavEntry = (e) => e.permission !== 'contacts.view' && e.featureFlag !== 'contracts';
    const paths = getStartPageOptions(noContacts).map((o) => o.path);
    expect(paths).not.toContain('/contacts');
    expect(paths).not.toContain('/contracts');
    expect(paths).toContain('/proposals');
  });
});

describe('resolveStartPage', () => {
  it('stays on the dashboard when unset or set to the dashboard', () => {
    expect(resolveStartPage(null, all)).toBeNull();
    expect(resolveStartPage(DASHBOARD_START_PAGE, all)).toBeNull();
    expect(resolveStartPage('/', all)).toBeNull();
  });

  it('returns an accessible module and ignores inaccessible or unknown paths', () => {
    expect(resolveStartPage('/calendars', all)).toBe('/calendars');
    expect(resolveStartPage('/calendars', (e) => e.path !== '/calendars')).toBeNull();
    expect(resolveStartPage('/not-a-module', all)).toBeNull();
  });
});
