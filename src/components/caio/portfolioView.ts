/**
 * Pure view logic for the CAIO module: portfolio sorting/filtering/counters and the "needs attention" lists on an
 * engagement. Mirrors the SQL in caio_portfolio (same closed-status idea) so the overview and the portfolio agree.
 * Unit-tested in portfolioView.test.ts.
 */
import { daysUntil, type CaioDocumentRow, type CaioRecord, type PortfolioRow } from '../../services/caio';

/** Statuses that mean "finished": a record in one of these never counts as overdue or open. */
const CLOSED = new Set([
  'closed', 'done', 'retired', 'superseded', 'revoked', 'rejected', 'not applicable', 'cancelled', 'canceled',
  'expired', 'released', 'rolled back', 'decided', 'attended', 'excused', 'missed',
]);

export function isFinished(status: string | null | undefined): boolean {
  return CLOSED.has((status ?? '').trim().toLowerCase());
}

export type StatusFilter = 'all' | 'active' | 'paused' | 'completed';

/** Rows by next gate date (soonest first, no open gate last), ties by engagement code. Does not mutate. */
export function sortPortfolio(rows: PortfolioRow[]): PortfolioRow[] {
  return [...rows].sort((a, b) => {
    const x = a.next_gate_due, y = b.next_gate_due;
    if (x && y && x !== y) return x < y ? -1 : 1;
    if (x && !y) return -1;
    if (!x && y) return 1;
    return a.engagement_code.localeCompare(b.engagement_code);
  });
}

export function filterPortfolio(rows: PortfolioRow[], status: StatusFilter): PortfolioRow[] {
  return status === 'all' ? rows : rows.filter((r) => r.status === status);
}

export interface PortfolioCounters { active: number; gatesDue14: number; overdueActions: number; openIncidents: number }

/** Header counters over ACTIVE engagements only (a paused or completed one is not asking for attention). */
export function portfolioCounters(rows: PortfolioRow[], now = new Date()): PortfolioCounters {
  const live = rows.filter((r) => r.status === 'active');
  return {
    active: live.length,
    gatesDue14: live.filter((r) => { const d = daysUntil(r.next_gate_due, now); return d !== null && d <= 14; }).length,
    overdueActions: live.reduce((n, r) => n + r.overdue_actions, 0),
    openIncidents: live.reduce((n, r) => n + r.open_incidents, 0),
  };
}

export interface AttentionLists {
  overdueActions: CaioRecord[];
  /** Not finished and expiring within 30 days, or approved and already past their date. */
  exceptions: CaioRecord[];
  openIncidents: CaioRecord[];
  /** Any other register row whose review/due date has passed. */
  reviewsOverdue: CaioRecord[];
  docsInProgress: CaioDocumentRow[];
  docsReviewOverdue: CaioDocumentRow[];
}

const byDue = (a: CaioRecord, b: CaioRecord) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.record_key.localeCompare(b.record_key);

export function buildAttention(records: CaioRecord[], docs: CaioDocumentRow[], now = new Date()): AttentionLists {
  const open = records.filter((r) => !isFinished(r.status));
  const overdue = (r: CaioRecord) => { const d = daysUntil(r.due_date, now); return d !== null && d < 0; };
  const exceptions = records.filter((r) => {
    if (r.register_key !== 'exceptions') return false;
    const d = daysUntil(r.due_date, now);
    if (d === null) return false;
    if ((r.status ?? '').trim().toLowerCase() === 'approved' && d < 0) return true;
    return !isFinished(r.status) && d >= 0 && d <= 30;
  });
  return {
    overdueActions: open.filter((r) => r.register_key === 'actions' && overdue(r)).sort(byDue),
    exceptions: exceptions.sort(byDue),
    openIncidents: open.filter((r) => r.register_key === 'incidents').sort(byDue),
    reviewsOverdue: open.filter((r) => r.register_key !== 'actions' && r.register_key !== 'exceptions' && overdue(r)).sort(byDue),
    docsInProgress: docs.filter((d) => d.status === 'draft' || d.status === 'in_review'),
    docsReviewOverdue: docs.filter((d) => { const n = daysUntil(d.next_review, now); return d.status === 'approved' && n !== null && n < 0; }),
  };
}

export function attentionTotal(a: AttentionLists): number {
  return a.overdueActions.length + a.exceptions.length + a.openIncidents.length + a.reviewsOverdue.length + a.docsInProgress.length + a.docsReviewOverdue.length;
}

/** Whole days since a date (0 on the day, negative before it). */
export function daysSince(date: string, now = new Date()): number {
  return 0 - (daysUntil(date, now) ?? 0);
}
