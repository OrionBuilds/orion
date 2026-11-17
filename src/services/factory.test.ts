import { describe, expect, it } from 'vitest';
import {
  actionRows, boardCounts, canRetry, defaultAutonomy, effectiveMode, filterRuns, groupByStage, runKind, stepTone, subjectLink,
  type BoardRun, type BoardStep, type PlaybookStep,
} from './factory';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

const step = (status: BoardStep['status'], updated = daysAgo(0), stage: string | null = 'Discovery'): BoardStep => ({
  id: `${status}-${updated}-${stage}`, key: 'k', title: 't', stage, agent: 'clara', role: null, status, required: true,
  attempts: 0, approval_id: null, gate: null, error: null, updated_at: updated,
});

const run = (over: Partial<BoardRun> = {}): BoardRun => ({
  run_id: 'r', playbook: 'P', playbook_slug: 'p', subject_type: 'opportunity', subject_id: 'o1', subject: 'Acme',
  brand: 'default', status: 'active', started_at: daysAgo(1), steps: [], ...over,
});

const pStep = (over: Partial<PlaybookStep>): PlaybookStep => ({
  id: 's', playbook_id: 'p', key: 'k', title: 'Step', stage_name: null, sort_order: 0, agent: 'clara', role_slug: null,
  instructions: '', deliverable: 'brief', action_key: 'research.brief', required: true, acceptance_criteria: [], max_attempts: 3,
  enabled: true, ...over,
});

describe('defaultAutonomy', () => {
  it('asks first for outward drafts and anything under finance.', () => {
    expect(defaultAutonomy({ deliverable: 'email_draft', action_key: 'sales.followup' })).toBe('approval');
    expect(defaultAutonomy({ deliverable: 'post_draft', action_key: 'social.post' })).toBe('approval');
    expect(defaultAutonomy({ deliverable: 'report', action_key: 'finance.invoice' })).toBe('approval');
  });
  it('runs internal work on its own', () => {
    expect(defaultAutonomy({ deliverable: 'brief', action_key: 'research.brief' })).toBe('auto');
    expect(defaultAutonomy({ deliverable: 'code', action_key: 'financial_model' })).toBe('auto');
  });
  it('lets a policy row override the default', () => {
    expect(effectiveMode(null, 'approval')).toBe('approval');
    expect(effectiveMode({ mode: 'off' }, 'auto')).toBe('off');
  });
});

describe('actionRows', () => {
  it('collapses steps by action_key, treats a shared key as sensitive if any use is, sensitive first', () => {
    const rows = actionRows([
      { name: 'Sales', steps: [pStep({ action_key: 'a.brief' }), pStep({ action_key: 'z.mail', deliverable: 'brief' })] },
      { name: 'Delivery', steps: [pStep({ action_key: 'z.mail', deliverable: 'email_draft', title: 'Kickoff email' })] },
    ]);
    expect(rows.map((r) => r.action_key)).toEqual(['z.mail', 'a.brief']);
    expect(rows[0]).toMatchObject({ default: 'approval', deliverables: ['brief', 'email_draft'] });
    expect(rows[0].steps).toHaveLength(2);
    expect(rows[1].default).toBe('auto');
  });
});

describe('board', () => {
  it('counts what waits on the owner, escalations, work in flight and done in the last 7 days', () => {
    const runs = [
      run({ steps: [step('needs_approval'), step('escalated'), step('queued'), step('running')] }),
      run({ steps: [step('done', daysAgo(2)), step('done', daysAgo(9)), step('failed'), step('skipped')] }),
    ];
    expect(boardCounts(runs, NOW)).toEqual({ waiting: 1, escalated: 1, inProgress: 2, done7d: 1 });
  });
  it('classifies runs and links deals and projects only', () => {
    expect(runKind(run())).toBe('deal');
    expect(runKind(run({ subject_type: 'org', subject_id: null }))).toBe('scheduled');
    expect(subjectLink(run())).toBe('/opportunities/o1');
    expect(subjectLink(run({ subject_type: 'project', subject_id: 'p1' }))).toBe('/projects/p1');
    expect(subjectLink(run({ subject_type: 'org', subject_id: null }))).toBeNull();
  });
  it('filters by brand (including no brand) and type', () => {
    const runs = [run({ run_id: 'a' }), run({ run_id: 'b', brand: null, subject_type: 'project' }), run({ run_id: 'c', brand: 'studio' })];
    expect(filterRuns(runs, { brand: 'all', kind: 'all' })).toHaveLength(3);
    expect(filterRuns(runs, { brand: 'none', kind: 'all' }).map((r) => r.run_id)).toEqual(['b']);
    expect(filterRuns(runs, { brand: 'all', kind: 'deal' }).map((r) => r.run_id)).toEqual(['a', 'c']);
    expect(filterRuns(runs, { brand: 'studio', kind: 'project' })).toEqual([]);
  });
  it('groups steps by stage in order, case-insensitively, with no stage as Start', () => {
    const groups = groupByStage([step('done', daysAgo(0), null), step('queued', daysAgo(0), 'Won'), step('queued', daysAgo(1), 'won')]);
    expect(groups.map((g) => [g.stage, g.steps.length])).toEqual([['Start', 1], ['Won', 2]]);
  });
  it('offers retry/skip only for steps that stopped, and colours them', () => {
    expect(['failed', 'escalated', 'expired', 'rejected'].every(canRetry)).toBe(true);
    expect(canRetry('done') || canRetry('needs_approval') || canRetry('running')).toBe(false);
    expect(stepTone('done')).toBe('ok');
    expect(stepTone('escalated')).toBe('bad');
    expect(stepTone('needs_approval')).toBe('warn');
    expect(stepTone('queued')).toBe('muted');
  });
});
