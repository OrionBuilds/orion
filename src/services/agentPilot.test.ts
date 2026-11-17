import { describe, expect, it } from 'vitest';
import { assessPilot, type PilotRow } from './agentPilot';

const row = (over: Partial<PilotRow> = {}): PilotRow => ({
  schedule_id: 's', agent_slug: 'clara', task_key: 'k', title: 'T', mode: 'shadow', risk_tier: 'owner_review', approval_required: true,
  thresholds: {}, runs: 0, failed: 0, approved: 0, edited: 0, rejected: 0, expired: 0, pending: 0, last_run_at: null, ...over,
});

describe('assessPilot', () => {
  it('collects until there are enough decided drafts', () => {
    const a = assessPilot(row({ approved: 10, rejected: 0 }));
    expect(a.verdict).toBe('collecting');
    expect(a.decided).toBe(10);
  });

  it('is ready to graduate at 95% over 50 decided drafts', () => {
    expect(assessPilot(row({ approved: 48, rejected: 2 })).verdict).toBe('ready_to_graduate');
  });

  it('is not ready at 94% even with plenty of drafts', () => {
    expect(assessPilot(row({ approved: 47, rejected: 3, expired: 0 })).verdict).toBe('collecting');
  });

  it('expired drafts count against the rate', () => {
    expect(assessPilot(row({ approved: 47, rejected: 0, expired: 3 })).verdict).toBe('collecting');
  });

  it('edited drafts are decided but are not approved untouched', () => {
    const a = assessPilot(row({ approved: 40, edited: 10 }));
    expect(a.decided).toBe(50);
    expect(a.approvalRate).toBeCloseTo(0.8);
    expect(a.verdict).toBe('collecting');
  });

  it('flags a kill review under 60% on 20+ decided drafts', () => {
    const a = assessPilot(row({ approved: 10, rejected: 12 }));
    expect(a.verdict).toBe('kill_review');
  });

  it('never graduates client-visible work', () => {
    expect(assessPilot(row({ risk_tier: 'client_visible', approved: 100 })).verdict).toBe('permanent_checkpoint');
  });

  it('honours per-schedule thresholds', () => {
    const a = assessPilot(row({ approved: 9, rejected: 1, thresholds: { min_decided: 10, min_approval_rate: 0.9 } }));
    expect(a.verdict).toBe('ready_to_graduate');
  });

  it('flags an active task whose approval rate has slipped', () => {
    expect(assessPilot(row({ mode: 'active', approved: 15, rejected: 10 })).verdict).toBe('active_slipping');
    expect(assessPilot(row({ mode: 'active', approved: 49, rejected: 1 })).verdict).toBe('active_ok');
  });

  it('ignores a null or out-of-range threshold instead of lowering the bar', () => {
    // JSON null / garbage for min_approval_rate must not let a 60% pilot graduate.
    const nulled = assessPilot(row({ approved: 30, rejected: 20, thresholds: { min_approval_rate: null as unknown as number } }));
    expect(nulled.minRate).toBe(0.95);
    expect(nulled.verdict).not.toBe('ready_to_graduate');

    const outOfRange = assessPilot(row({ approved: 30, rejected: 20, thresholds: { min_approval_rate: 2 } }));
    expect(outOfRange.minRate).toBe(0.95);

    const badDecided = assessPilot(row({ approved: 9, rejected: 1, thresholds: { min_decided: -5 } }));
    expect(badDecided.minDecided).toBe(50);
  });
});
