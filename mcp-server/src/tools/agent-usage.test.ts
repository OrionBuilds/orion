import { describe, it, expect, vi } from 'vitest';

vi.mock('../helpers/rest-client.js', () => ({
  restGet: vi.fn(),
  restPost: vi.fn(),
  restRpc: vi.fn(),
}));

import { buildUsageRows, usageCallSchema } from './agent-usage.js';

const caller = { user_id: 'u-friday', organization_id: 'org-1', agent_slug: 'friday' };
const now = new Date('2026-10-29T12:00:00Z');

describe('buildUsageRows', () => {
  it('files calls under the caller and keeps unknown cost as null', () => {
    const { rows, rejected } = buildUsageRows(caller, [
      { id: 'mc_1', ts: '2026-10-29T11:00:00Z', provider: 'Anthropic', model: 'claude-opus-5-5', auth_type: 'subscription', engine: 'claude-cli',
        input_tokens: 1200, output_tokens: 300, cost_usd: 0.42, run_id: '7d1d3f0e-8a5e-4a7b-9a51-2f7a3e6b2c11', task_ref: 'task_9' },
      { id: 'mc_2', ts: '2026-10-29T11:05:00Z', provider: 'lmstudio', auth_type: 'local', run_id: 'not-a-uuid' },
    ], now);
    expect(rejected).toEqual([]);
    expect(rows[0]).toMatchObject({
      org_id: 'org-1', agent: 'friday', agent_user_id: 'u-friday', provider: 'anthropic', model: 'claude-opus-5-5',
      auth_type: 'subscription', source: 'claude-cli', cost_usd: 0.42, cost_source: 'reported', external_id: 'mc_1',
      run_id: '7d1d3f0e-8a5e-4a7b-9a51-2f7a3e6b2c11', task_ref: 'task_9', created_at: '2026-10-29T11:00:00.000Z',
    });
    expect(rows[1]).toMatchObject({ model: 'unknown', cost_usd: null, cost_source: 'unknown', run_id: null, input_tokens: 0, status: 'ok' });
  });

  it('rejects unparseable and future timestamps', () => {
    const { rows, rejected } = buildUsageRows(caller, [
      { id: 'bad', ts: 'yesterday-ish', provider: 'x', auth_type: 'unknown' },
      { id: 'future', ts: '2026-10-30T00:00:00Z', provider: 'x', auth_type: 'unknown' },
    ], now);
    expect(rows).toEqual([]);
    expect(rejected).toEqual(['bad', 'future']);
  });

  it('schema refuses negative tokens', () => {
    expect(usageCallSchema.safeParse({ id: 'a', ts: 'x', provider: 'p', auth_type: 'api_key', input_tokens: -1 }).success).toBe(false);
  });
});
