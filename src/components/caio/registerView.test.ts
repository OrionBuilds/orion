import { describe, expect, it } from 'vitest';
import type { CaioRecord, RegisterField } from '../../services/caio';
import {
  distinctValues, exportFileName, filterRecords, filtersActive, historyChanges, isUrl, NO_FILTERS, pageCount, pageSlice, pickColumns,
  sortRecords, truncate,
} from './registerView';

const f = (key: string, over: Partial<RegisterField> = {}): RegisterField => ({
  register_key: 'risk', field_key: key, label: key, ftype: 'text', sort: 0, options: null, promote_as: null, is_id: false, is_due: false, client_safe: true, ...over,
});
const def = {
  fields: [
    f('id', { is_id: true }), f('scenario', { ftype: 'longtext' }), f('tier', { ftype: 'select', promote_as: 'risk_tier' }),
    f('owner', { promote_as: 'owner' }), f('state', { ftype: 'select', promote_as: 'status' }), f('due', { ftype: 'date', is_due: true }), f('notes'),
  ],
};
const rec = (key: string, over: Partial<CaioRecord> = {}): CaioRecord => ({
  id: key, engagement_id: 'e', register_key: 'risk', record_key: key, data: {}, status: null, due_date: null, risk_tier: null,
  owner_name: null, system_key: null, client_visible: false, updated_at: '', ...over,
});

describe('pickColumns', () => {
  it('takes the first non-ID text field, then status, tier, owner, due; max 5', () => {
    expect(pickColumns(def).map((x) => x.field_key)).toEqual(['scenario', 'state', 'tier', 'owner', 'due']);
  });
  it('skips what the register does not have', () => {
    expect(pickColumns({ fields: [f('id', { is_id: true }), f('name')] }).map((x) => x.field_key)).toEqual(['name']);
  });
});

describe('filterRecords', () => {
  const rows = [
    rec('R-1', { data: { scenario: 'Data leak' }, status: 'Open', owner_name: 'Ann', due_date: '2026-10-01', client_visible: true }),
    rec('R-2', { data: { scenario: 'Outage' }, status: 'Closed', owner_name: 'Bob', due_date: '2026-12-01' }),
    rec('R-3', { data: { scenario: 'Drift' }, status: 'Open', owner_name: 'Bob' }),
  ];
  it('searches values and keys', () => {
    expect(filterRecords(rows, { ...NO_FILTERS, search: 'outage' }, '2026-11-04').map((r) => r.record_key)).toEqual(['R-2']);
    expect(filterRecords(rows, { ...NO_FILTERS, search: 'r-3' }, '2026-11-04')).toHaveLength(1);
  });
  it('combines status, owner, overdue and client filters', () => {
    expect(filterRecords(rows, { ...NO_FILTERS, status: 'Open', owner: 'Bob' }, '2026-11-04').map((r) => r.record_key)).toEqual(['R-3']);
    expect(filterRecords(rows, { ...NO_FILTERS, overdueOnly: true }, '2026-11-04').map((r) => r.record_key)).toEqual(['R-1']);
    expect(filterRecords(rows, { ...NO_FILTERS, clientOnly: true }, '2026-11-04').map((r) => r.record_key)).toEqual(['R-1']);
  });
  it('reports activity and distinct values', () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: ' x ' })).toBe(true);
    expect(distinctValues(rows, 'owner_name')).toEqual(['Ann', 'Bob']);
  });
});

describe('sortRecords', () => {
  const rows = [rec('R-10', { due_date: '2026-12-01' }), rec('R-2', { due_date: '2026-10-01' }), rec('R-3')];
  it('sorts record keys naturally', () => {
    expect(sortRecords(rows, 'record_key', 'asc').map((r) => r.record_key)).toEqual(['R-2', 'R-3', 'R-10']);
    expect(sortRecords(rows, 'record_key', 'desc').map((r) => r.record_key)).toEqual(['R-10', 'R-3', 'R-2']);
  });
  it('sorts due dates with empty ones last either way', () => {
    expect(sortRecords(rows, 'due_date', 'asc').map((r) => r.record_key)).toEqual(['R-2', 'R-10', 'R-3']);
    expect(sortRecords(rows, 'due_date', 'desc').map((r) => r.record_key)).toEqual(['R-10', 'R-2', 'R-3']);
  });
});

describe('historyChanges', () => {
  it('shows old -> new per changed field and client visibility', () => {
    const out = historyChanges(def, {
      op: 'update', old_data: { state: 'Open', notes: 'a', _client_visible: false }, new_data: { state: 'Closed', notes: 'a', _client_visible: true },
    });
    expect(out).toEqual([
      { key: 'state', label: 'state', from: 'Open', to: 'Closed' },
      { key: '_client_visible', label: 'Client visibility', from: 'hidden', to: 'visible' },
    ]);
  });
  it('lists the removed values on delete and handles added fields', () => {
    expect(historyChanges(def, { op: 'delete', old_data: { notes: 'x' }, new_data: null })[0]).toMatchObject({ from: 'x', to: '(empty)' });
    expect(historyChanges(def, { op: 'update', old_data: {}, new_data: { notes: 'n' } })[0]).toMatchObject({ from: '(empty)', to: 'n' });
  });
});

describe('small helpers', () => {
  it('truncates, detects URLs, pages and names files', () => {
    expect(truncate('a'.repeat(100), 10)).toHaveLength(10);
    expect(isUrl('https://x.io/a')).toBe(true);
    expect(isUrl('see https://x.io')).toBe(false);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(101)).toBe(3);
    expect(pageSlice([1, 2, 3], 1, 2)).toEqual([3]);
    expect(exportFileName('CAIO-001', 'risk', '2026-11-04')).toBe('CAIO-001-risk-2026-11-04.csv');
  });
});
