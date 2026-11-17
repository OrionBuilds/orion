import { describe, it, expect, vi } from 'vitest';

// The query builder is pure; stub config so importing the module never needs real env.
vi.mock('../config.js', () => ({ config: { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'anon', accessToken: '' } }));

import { buildQueryString } from './rest-client.js';

const q = (filters: Record<string, string>) => decodeURIComponent(buildQueryString({ filters }));

describe('buildQueryString filter normalization', () => {
  it('prefixes eq. on a raw value (the 2026-08-24 normalization still holds)', () => {
    expect(q({ status: 'active' })).toBe('?status=eq.active');
    expect(q({ status: 'eq.active', owner_id: 'neq.x' })).toBe('?status=eq.active&owner_id=neq.x');
  });

  it("passes PostgREST logic trees through untouched — contacts_list search sent or=eq.(…) and 400'd", () => {
    const tree = '(first_name.ilike.*Casey*,last_name.ilike.*Casey*,email.ilike.*Casey*,company.ilike.*Casey*)';
    expect(q({ or: tree })).toBe(`?or=${tree}`);
    expect(q({ and: '(a.eq.1,b.eq.2)' })).toBe('?and=(a.eq.1,b.eq.2)');
    expect(q({ 'not.or': '(a.eq.1,b.eq.2)' })).toBe('?not.or=(a.eq.1,b.eq.2)');
  });

  it('the tasks tools\' or filters survive too', () => {
    expect(q({ or: '(assigned_to_user_id.eq.u1,created_by_user_id.eq.u1)' })).toBe('?or=(assigned_to_user_id.eq.u1,created_by_user_id.eq.u1)');
  });
});
