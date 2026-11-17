import { describe, expect, it } from 'vitest';
import { attentionTotal, buildAttention, daysSince, filterPortfolio, isFinished, portfolioCounters, sortPortfolio } from './portfolioView';
import type { CaioDocumentRow, CaioRecord, PortfolioRow } from '../../services/caio';

const NOW = new Date(2026, 10, 4, 12);

const row = (over: Partial<PortfolioRow> = {}): PortfolioRow => ({
  engagement_id: 'e', engagement_code: 'CAIO-001', client_legal_name: 'Acme', project_id: 'p', status: 'active', kickoff_date: '2026-10-01',
  portal_enabled: false, next_gate: null, next_gate_due: '2026-12-01', overdue_actions: 0, exceptions_expiring_30d: 0, exceptions_expired: 0,
  open_incidents: 0, reviews_overdue: 0, documents_in_progress: 0, documents_review_overdue: 0, systems: 0, ...over,
});
const rec = (register_key: string, status: string | null, due_date: string | null, record_key = 'X-001'): CaioRecord => ({
  id: `${register_key}${record_key}`, engagement_id: 'e', register_key, record_key, data: {}, status, due_date, risk_tier: null,
  owner_name: null, system_key: null, client_visible: false, updated_at: '',
});
const doc = (status: CaioDocumentRow['status'], next_review: string | null = null): CaioDocumentRow => ({
  id: status + next_review, engagement_id: 'e', template_id: null, template_number: 1, title: 'D', system_key: null, version: 1, status,
  owner_name: null, approver_name: null, approval_ref: null, approved_at: null, next_review, evidence_link: null, client_visible: false, updated_at: '',
});

describe('isFinished', () => {
  it('treats closed-like statuses as finished, case-insensitively', () => {
    expect(isFinished('Closed')).toBe(true);
    expect(isFinished(' Not Applicable ')).toBe(true);
    expect(isFinished('Rolled back')).toBe(true);
    expect(isFinished('Open')).toBe(false);
    expect(isFinished(null)).toBe(false);
  });
});

describe('sortPortfolio / filterPortfolio', () => {
  it('sorts by next gate date with no open gate last, without mutating', () => {
    const rows = [row({ engagement_code: 'C', next_gate_due: null }), row({ engagement_code: 'B', next_gate_due: '2026-12-05' }), row({ engagement_code: 'A', next_gate_due: '2026-11-20' })];
    expect(sortPortfolio(rows).map((r) => r.engagement_code)).toEqual(['A', 'B', 'C']);
    expect(rows[0].engagement_code).toBe('C');
  });
  it('filters by status', () => {
    const rows = [row({ status: 'paused' }), row({ status: 'active' })];
    expect(filterPortfolio(rows, 'active')).toHaveLength(1);
    expect(filterPortfolio(rows, 'all')).toHaveLength(2);
  });
});

describe('portfolioCounters', () => {
  it('counts active engagements only', () => {
    const c = portfolioCounters([
      row({ next_gate_due: '2026-11-10', overdue_actions: 2, open_incidents: 1 }),
      row({ next_gate_due: '2026-11-01', overdue_actions: 1 }),
      row({ next_gate_due: '2027-01-01' }),
      row({ status: 'paused', next_gate_due: '2026-11-05', overdue_actions: 9, open_incidents: 9 }),
    ], NOW);
    expect(c).toEqual({ active: 3, gatesDue14: 2, overdueActions: 3, openIncidents: 1 });
  });
});

describe('buildAttention', () => {
  const records = [
    rec('actions', 'Open', '2026-11-01', 'ACT-001'),
    rec('actions', 'Done', '2026-10-01', 'ACT-002'),
    rec('actions', 'Open', '2026-11-20', 'ACT-003'),
    rec('exceptions', 'Approved', '2026-10-30', 'EXC-001'),
    rec('exceptions', 'Requested', '2026-11-20', 'EXC-002'),
    rec('exceptions', 'Requested', '2027-02-01', 'EXC-003'),
    rec('exceptions', 'Expired', '2026-10-30', 'EXC-004'),
    rec('incidents', 'Investigating', null, 'INC-001'),
    rec('incidents', 'Closed', null, 'INC-002'),
    rec('risks', 'Open', '2026-10-15', 'RSK-001'),
    rec('risks', 'Retired', '2026-10-15', 'RSK-002'),
  ];
  const a = buildAttention(records, [doc('draft'), doc('in_review'), doc('approved', '2026-10-01'), doc('approved', '2027-01-01')], NOW);

  it('lists overdue open actions only', () => expect(a.overdueActions.map((r) => r.record_key)).toEqual(['ACT-001']));
  it('lists expiring and expired-but-approved exceptions', () => expect(a.exceptions.map((r) => r.record_key)).toEqual(['EXC-001', 'EXC-002']));
  it('lists open incidents', () => expect(a.openIncidents.map((r) => r.record_key)).toEqual(['INC-001']));
  it('lists overdue reviews on other registers', () => expect(a.reviewsOverdue.map((r) => r.record_key)).toEqual(['RSK-001']));
  it('lists documents in progress and overdue reviews', () => {
    expect(a.docsInProgress).toHaveLength(2);
    expect(a.docsReviewOverdue).toHaveLength(1);
  });
  it('totals', () => expect(attentionTotal(a)).toBe(1 + 2 + 1 + 1 + 2 + 1));
});

describe('daysSince', () => {
  it('counts whole days', () => {
    expect(daysSince('2026-11-01', NOW)).toBe(3);
    expect(daysSince('2026-11-04', NOW)).toBe(0);
  });
});
