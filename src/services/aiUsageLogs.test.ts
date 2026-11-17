import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

import { mapCallUsage } from './aiUsageLogs';

const base = {
  id: '1', org_id: 'o', agent: 'clara', agent_user_id: 'u1', provider: 'anthropic', model: 'claude-haiku-4-5',
  source: 'clara-turn', purpose: null, input_tokens: 100, output_tokens: 20, cost_usd: 0.001, task_ref: null,
  run_id: null, status: 'ok', duration_ms: 800, created_at: '2026-11-11T10:00:00Z',
};

describe('mapCallUsage', () => {
  it('maps a successful call onto the log shape the tab renders', () => {
    const l = mapCallUsage(base);
    expect(l.status).toBe('success');
    expect(l.agent_name).toBe('Clara');
    expect(l.model_key).toBe('claude-haiku-4-5');
    expect(l.action_summary).toBe('clara-turn');
    expect(l.error_message).toBeNull();
    expect(l.duration_ms).toBe(800);
  });

  it('marks failures and uses the recorded error text, else a generic one naming provider and model', () => {
    expect(mapCallUsage({ ...base, status: 'error', error_message: 'overloaded_error' }).error_message).toBe('overloaded_error');
    const generic = mapCallUsage({ ...base, status: 'error', purpose: 'triage' });
    expect(generic.status).toBe('failed');
    expect(generic.action_summary).toBe('triage');
    expect(generic.error_message).toContain('anthropic claude-haiku-4-5');
  });

  it('tolerates missing agent and duration', () => {
    const l = mapCallUsage({ ...base, agent: null, duration_ms: null, model: null });
    expect(l.agent_name).toBe('Unknown');
    expect(l.duration_ms).toBe(0);
    expect(l.model_key).toBe('unknown');
  });
});
