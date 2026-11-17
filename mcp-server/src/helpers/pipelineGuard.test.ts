import { describe, it, expect, vi } from 'vitest';

// The guard module also exports PostgREST-backed helpers; stub the network
// layer so importing it never touches config/fetch. Only the pure parts are
// exercised here.
vi.mock('./rest-client.js', () => ({
  restGet: vi.fn(),
  restPost: vi.fn(),
  restRpc: vi.fn(),
}));

import { decideOwnership, isAgent, normaliseCallerSlug, sortStages, type Caller, type PipelineRef } from './pipelineGuard.js';

const human: Caller = {
  user_id: 'u-human',
  organization_id: 'org-1',
  email: 'jordan@example.com',
  role: 'owner',
  agent_slug: null,
};
const friday: Caller = { ...human, user_id: 'u-friday', email: 'friday@example.com', role: 'agent', agent_slug: 'friday' };
const clara: Caller = { ...human, user_id: 'u-clara', email: 'clara@example.com', role: 'agent', agent_slug: 'clara' };

const engineering: PipelineRef = { id: 'p-eng', name: 'Engineering', owner_agent: 'friday' };
const personal: PipelineRef = { id: 'p-own', name: 'Owner', owner_agent: 'clara' };
const unowned: PipelineRef = { id: 'p-none', name: 'Unassigned', owner_agent: null };

describe('isAgent', () => {
  it('distinguishes agents from humans by agent_slug', () => {
    expect(isAgent(human)).toBe(false);
    expect(isAgent(friday)).toBe(true);
  });
});

describe('decideOwnership', () => {
  it('always allows humans, including on unowned pipelines', () => {
    expect(decideOwnership(human, engineering)).toEqual({ ok: true });
    expect(decideOwnership(human, personal)).toEqual({ ok: true });
    expect(decideOwnership(human, unowned)).toEqual({ ok: true });
  });

  it('allows an agent on the pipeline it owns', () => {
    expect(decideOwnership(friday, engineering)).toEqual({ ok: true });
    expect(decideOwnership(clara, personal)).toEqual({ ok: true });
  });

  it('refuses a mismatched agent and names the pipeline and its owner', () => {
    const d = decideOwnership(clara, engineering);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toContain('CLARA (clara)');
    expect(d.reason).toContain('"Engineering"');
    expect(d.reason).toContain('friday');

    const d2 = decideOwnership(friday, personal);
    expect(d2.ok).toBe(false);
    if (d2.ok) return;
    expect(d2.reason).toContain('"Owner"');
    expect(d2.reason).toContain('clara');
  });

  it('refuses every agent on a pipeline with no owner and points at the admin fix', () => {
    for (const agent of [friday, clara]) {
      const d = decideOwnership(agent, unowned);
      expect(d.ok).toBe(false);
      if (d.ok) continue;
      expect(d.reason).toContain('pipeline "Unassigned" has no owner agent');
      expect(d.reason).toContain('Projects › Pipelines');
    }
  });
});

describe('normaliseCallerSlug', () => {
  it('maps humans to null and active agents to their slug', () => {
    expect(normaliseCallerSlug(null)).toBeNull();
    expect(normaliseCallerSlug(undefined)).toBeNull();
    expect(normaliseCallerSlug('')).toBeNull();
    expect(normaliseCallerSlug(' FRIDAY ')).toBe('friday');
    expect(normaliseCallerSlug('clara')).toBe('clara');
  });

  it('refuses a retired or unknown agent slug instead of treating it as a human', () => {
    expect(() => normaliseCallerSlug('retired-agent')).toThrow(/not an active agent/);
    expect(() => normaliseCallerSlug('someone-else')).toThrow(/not an active agent/);
  });
});

describe('sortStages', () => {
  it('orders by sort_order without mutating the input', () => {
    const input = [
      { id: 'c', name: 'Done', sort_order: 3 },
      { id: 'a', name: 'Backlog', sort_order: 1 },
      { id: 'b', name: 'In progress', sort_order: 2 },
    ];
    expect(sortStages(input).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(input[0].id).toBe('c');
    expect(sortStages(undefined)).toEqual([]);
  });
});
