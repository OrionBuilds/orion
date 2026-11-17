import { describe, expect, it } from 'vitest';
import { AGENT_REGISTRY, childrenOf, rootAgents } from './agentRegistry';

// Same pattern as the agent_settings.agent_key CHECK constraint and _shared/agent-settings.ts.
const AGENT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,40}(\.[a-z0-9][a-z0-9-]{0,40})?$/;

describe('agentRegistry', () => {
  it('has unique keys that satisfy the agent_settings key constraint', () => {
    const keys = AGENT_REGISTRY.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(AGENT_KEY_PATTERN);
  });

  it('nests every subagent under an existing root as <parent>.<id>', () => {
    const roots = rootAgents().map((a) => a.key);
    expect(roots).toEqual(['clara', 'friday']);
    for (const a of AGENT_REGISTRY.filter((x) => x.parent)) {
      expect(roots).toContain(a.parent);
      expect(a.key.startsWith(`${a.parent}.`)).toBe(true);
    }
  });

  it('lists the subagents defined in the agent repos', () => {
    expect(childrenOf('clara').map((a) => a.key.split('.')[1])).toEqual([
      'front-desk', 'scheduler', 'inbox-triage', 'contracts-docs', 'researcher', 'advisor',
    ]);
    expect(childrenOf('friday').filter((a) => a.group === 'Department subagents').length).toBe(7);
    expect(childrenOf('friday').filter((a) => a.group === 'Dispatch specialists').length).toBe(11);
  });
});
