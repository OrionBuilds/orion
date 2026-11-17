import { describe, expect, it } from 'vitest';
import {
  buildScheduleConfig,
  describeCadence,
  instructionTaskKey,
  isBuilderAgent,
  LIMITS,
  questionRounds,
  recommendedMode,
  validateMessages,
  validateProposal,
  type TaskProposal,
} from '../../supabase/functions/_shared/agent-task-proposal';

const base = {
  title: 'Morning client inbox sweep',
  summary: 'Every weekday CLARA reads your inbox and lists client emails needing a reply today.',
  instructions: 'Read the owner inbox since the last run. List client emails needing a reply today.',
  cadence: 'daily',
  time_of_day: '07:30',
  days_of_week: [],
  day_of_month: 0,
  timezone: 'America/New_York',
  risk_tier: 'autonomous',
  output_kind: 'owner_briefing',
  output_destination: 'Your OS inbox',
  approval_required: false,
  external_effects: false,
  scope: 'Owner inbox only',
  success_criteria: 'Every client email needing a same-day reply is listed.',
};

function ok(raw: unknown): TaskProposal {
  const v = validateProposal(raw);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.proposal;
}

describe('validateProposal', () => {
  it('accepts a valid daily proposal and drops cadence fields that do not apply', () => {
    const p = ok(base);
    expect(p.cadence).toBe('daily');
    expect(p.days_of_week).toBeNull();
    expect(p.day_of_month).toBeNull();
    expect(p.approval_required).toBe(false);
  });

  it('drops unknown keys so nothing extra reaches config', () => {
    const p = ok({ ...base, task_key: 'friday.drop_tables', config: { evil: true } });
    expect(p).not.toHaveProperty('task_key');
    expect(p).not.toHaveProperty('config');
  });

  it('rejects values outside the DB allow-lists', () => {
    const v = validateProposal({ ...base, cadence: 'custom_cron', risk_tier: 'yolo', output_kind: 'tweet' });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.join(' ')).toMatch(/cadence/);
      expect(v.errors.join(' ')).toMatch(/risk_tier/);
      expect(v.errors.join(' ')).toMatch(/output_kind/);
    }
  });

  it('requires title, summary and instructions, and enforces length caps', () => {
    expect(validateProposal({ ...base, title: '  ' }).ok).toBe(false);
    expect(validateProposal({ ...base, summary: '' }).ok).toBe(false);
    expect(validateProposal({ ...base, instructions: 'x'.repeat(LIMITS.instructions + 1) }).ok).toBe(false);
  });

  it('validates time, timezone and non-object input', () => {
    expect(validateProposal({ ...base, time_of_day: '25:00' }).ok).toBe(false);
    expect(ok({ ...base, time_of_day: '7:05' }).time_of_day).toBe('07:05');
    expect(validateProposal({ ...base, timezone: 'Mars/Olympus' }).ok).toBe(false);
    expect(ok({ ...base, timezone: '' }).timezone).toBe('America/New_York');
    expect(validateProposal(null).ok).toBe(false);
    expect(validateProposal([base]).ok).toBe(false);
  });

  it('requires days for weekly and sorts/dedupes them', () => {
    expect(validateProposal({ ...base, cadence: 'weekly', days_of_week: [] }).ok).toBe(false);
    expect(validateProposal({ ...base, cadence: 'weekly', days_of_week: [7] }).ok).toBe(false);
    expect(ok({ ...base, cadence: 'weekly', days_of_week: [4, 1, 4] }).days_of_week).toEqual([1, 4]);
  });

  it('requires a 1..31 day for monthly', () => {
    expect(validateProposal({ ...base, cadence: 'monthly', day_of_month: 0 }).ok).toBe(false);
    expect(ok({ ...base, cadence: 'monthly', day_of_month: 15 }).day_of_month).toBe(15);
  });

  it('requires booleans for approval and external effects', () => {
    expect(validateProposal({ ...base, approval_required: 'maybe' }).ok).toBe(false);
    expect(validateProposal({ ...base, external_effects: undefined }).ok).toBe(false);
  });

  it('forces approval and owner_review for anything with external effects', () => {
    const v = validateProposal({ ...base, external_effects: true });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.proposal.risk_tier).toBe('owner_review');
      expect(v.proposal.approval_required).toBe(true);
      expect(v.adjustments.length).toBeGreaterThan(0);
    }
  });

  it('forces client_visible + approval for client deliverables', () => {
    const p = ok({ ...base, output_kind: 'client_deliverable' });
    expect(p.risk_tier).toBe('client_visible');
    expect(p.approval_required).toBe(true);
  });
});

describe('recommendedMode', () => {
  it('starts risky work in shadow and internal work active', () => {
    expect(recommendedMode(ok(base))).toBe('active');
    expect(recommendedMode(ok({ ...base, external_effects: true }))).toBe('shadow');
    expect(recommendedMode(ok({ ...base, risk_tier: 'client_visible' }))).toBe('shadow');
  });
});

describe('validateMessages', () => {
  it('accepts an owner-first conversation ending with the owner', () => {
    const v = validateMessages([
      { role: 'user', content: 'Do X' },
      { role: 'assistant', content: 'When?' },
      { role: 'user', content: 'Daily' },
    ]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(questionRounds(v.messages)).toBe(1);
  });

  it('rejects bad roles, empty content, assistant-first and oversize input', () => {
    expect(validateMessages([]).ok).toBe(false);
    expect(validateMessages([{ role: 'system', content: 'x' }]).ok).toBe(false);
    expect(validateMessages([{ role: 'user', content: '   ' }]).ok).toBe(false);
    expect(validateMessages([{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'x' }]).ok).toBe(false);
    expect(validateMessages([{ role: 'user', content: 'x'.repeat(LIMITS.messageChars + 1) }]).ok).toBe(false);
    const many = Array.from({ length: LIMITS.messages + 1 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }));
    expect(validateMessages(many).ok).toBe(false);
  });

  it('requires the owner to have spoken last unless storing a transcript', () => {
    const t = [{ role: 'user', content: 'Do X' }, { role: 'assistant', content: 'I propose…' }];
    expect(validateMessages(t).ok).toBe(false);
    expect(validateMessages(t, { requireLastUser: false }).ok).toBe(true);
  });
});

describe('buildScheduleConfig / helpers', () => {
  it('builds config only from validated fields and caps the transcript', () => {
    const p = ok(base);
    const transcript = [{ role: 'user' as const, content: 'y'.repeat(5000) }];
    const cfg = buildScheduleConfig(p, { createdBy: 'u1', createdAt: '2026-10-28T00:00:00Z', model: 'm', transcript });
    expect(cfg.instructions).toBe(p.instructions);
    expect(cfg.external_effects).toBe(false);
    const builder = cfg.builder as { source: string; transcript: Array<{ content: string }> };
    expect(builder.source).toBe('agent-task-builder');
    expect(builder.transcript[0].content.length).toBe(1500);
  });

  it('maps agents to one generic task key each', () => {
    expect(instructionTaskKey('clara')).toBe('clara.instruction');
    expect(instructionTaskKey('friday')).toBe('friday.instruction');
    expect(isBuilderAgent('retired-agent')).toBe(false);
  });

  it('describes cadences in plain English', () => {
    expect(describeCadence(ok({ ...base, cadence: 'weekly', days_of_week: [1, 4] }))).toBe(
      'Weekly on Mon, Thu at 07:30 (America/New_York)',
    );
    expect(describeCadence(ok({ ...base, cadence: 'hourly', time_of_day: '00:15' }))).toBe(
      'Every hour at :15 (America/New_York)',
    );
  });
});
