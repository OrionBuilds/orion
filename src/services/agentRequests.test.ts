import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

import { failureReason, groupStopped, stoppedByAgent, stoppedOnly, type StoppedRequest } from './agentRequests';

const NOW = Date.parse('2026-11-12T18:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const req = (over: Partial<StoppedRequest>): StoppedRequest => ({
  id: 'r1', title: 'Project plan', kind: 'task', status: 'failed', error: 'Error: codex CLI failed (code 1): {"budget": 0}', result_summary: null,
  to_user_id: 'friday', source: { channel: 'factory', playbook: 'delivery-engineering' }, created_at: iso(2 * DAY), updated_at: iso(2 * DAY),
  ...over,
});

describe('stoppedOnly', () => {
  it('keeps every failure, and a question only once it is too old to answer', () => {
    const rows = [
      req({ id: 'failed-new', updated_at: iso(60_000) }),
      req({ id: 'question-live', status: 'needs_input', updated_at: iso(2 * DAY) }),
      req({ id: 'question-stale', status: 'needs_input', updated_at: iso(15 * DAY) }),
    ];
    expect(stoppedOnly(rows, NOW).map((r) => r.id)).toEqual(['failed-new', 'question-stale']);
  });
});

describe('groupStopped', () => {
  it('puts a whole outage in one group and keeps a different failure apart', () => {
    const rows = [
      req({ id: 'a', created_at: iso(2 * DAY + 60_000) }),
      req({ id: 'b', created_at: iso(2 * DAY) }),
      req({ id: 'c', error: 'Error: codex CLI failed (code 1): * Empty advisor tab\n  at spawn…', created_at: iso(2 * DAY + 120_000) }),
      req({ id: 'k', title: 'Refresh project knowledge: AI Roof Tool', error: "This project isn't linked to a FRIDAY project.", source: { channel: 'project_knowledge' }, created_at: iso(8 * DAY) }),
    ];
    const groups = groupStopped(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ title: 'Project plan', reason: 'codex CLI failed (code 1)', playbook: 'delivery-engineering' });
    expect(groups[0].ids.sort()).toEqual(['a', 'b', 'c']);
    expect(groups[0].first).toBe(iso(2 * DAY + 120_000));
    expect(groups[0].last).toBe(iso(2 * DAY));
    expect(groups[0].detail).toBeNull();
    expect(groups[1]).toMatchObject({
      title: 'Refresh project knowledge: AI Roof Tool', reason: "This project isn't linked to a FRIDAY project.", detail: null, playbook: null, ids: ['k'],
    });
  });

  it('says what a stale question asked, and never leaves the reason blank', () => {
    const groups = groupStopped([
      req({ id: 'q', status: 'needs_input', title: 'what projects are you connected to', error: null, result_summary: 'Which workspace do you mean?' }),
      req({ id: 'f', title: 'Other', error: '   ' }),
    ]);
    expect(groups.find((g) => g.ids[0] === 'q')).toMatchObject({ status: 'needs_input', reason: 'Which workspace do you mean?' });
    expect(groups.find((g) => g.ids[0] === 'f')?.reason).toBe('No reason was recorded');
  });
});

describe('failureReason', () => {
  it('separates what failed from the output of whatever broke', () => {
    expect(failureReason('Error: codex CLI failed (code 1): "risk_level": "low"')).toEqual({ reason: 'codex CLI failed (code 1)', detail: '"risk_level": "low"' });
    expect(failureReason('lease expired')).toEqual({ reason: 'lease expired', detail: null });
    expect(failureReason(null)).toEqual({ reason: 'No reason was recorded', detail: null });
  });

  it('keeps the detail of a failure that happened once', () => {
    expect(groupStopped([req({ id: 'solo' })])[0]).toMatchObject({ reason: 'codex CLI failed (code 1)', detail: '{"budget": 0}' });
  });
});

describe('stoppedByAgent', () => {
  it('counts per agent', () => {
    const m = stoppedByAgent([req({ id: 'a' }), req({ id: 'b' }), req({ id: 'c', to_user_id: 'harvey' })]);
    expect([...m.entries()]).toEqual([['friday', 2], ['harvey', 1]]);
  });
});
