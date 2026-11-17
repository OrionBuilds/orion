import { describe, expect, it } from 'vitest';
import { formerContactLabel } from './formerContact';

const base = { id: 'c1', email: null, first_name: null, last_name: null, company: null, phone: null, deleted_at: '2026-10-28T23:00:00Z' };

describe('formerContactLabel', () => {
  it('prefers company, then name, then email, and marks it unlinked', () => {
    expect(formerContactLabel({ ...base, company: 'Umbrella Roofing Inc.', first_name: 'Ana' })).toBe('Umbrella Roofing Inc. (unlinked)');
    expect(formerContactLabel({ ...base, first_name: 'Ana', last_name: 'Diaz' })).toBe('Ana Diaz (unlinked)');
    expect(formerContactLabel({ ...base, email: 'ana@client.com' })).toBe('ana@client.com (unlinked)');
  });

  it('returns null when there is nothing to show', () => {
    expect(formerContactLabel(null)).toBeNull();
    expect(formerContactLabel(undefined)).toBeNull();
    expect(formerContactLabel(base)).toBeNull();
  });
});
