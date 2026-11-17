import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConditionEvaluationContext } from '../types/conditions';
import {
  createDynamicFieldValue,
  createDynamicFunctionValue,
  resolveDynamicValue,
} from './dynamicValueResolver';

const context: ConditionEvaluationContext = {
  entityType: 'contact',
  entityId: 'c-1',
  entityData: {
    contact: { first_name: 'Ann', owner: { name: 'Bob' } },
    created_at: '2026-06-05T00:00:00Z',
  },
  relatedEntities: { opportunity: { name: 'Big Deal' } },
  currentUser: { id: 'u-1', org_id: 'org-1', role: 'admin' },
  timestamp: '2026-06-15T12:00:00Z',
};

describe('resolveDynamicValue', () => {
  it('returns plain values unchanged', () => {
    expect(resolveDynamicValue('literal', context)).toBe('literal');
    expect(resolveDynamicValue(42, context)).toBe(42);
    expect(resolveDynamicValue(null, context)).toBeNull();
    expect(resolveDynamicValue({ type: 'field' }, context)).toEqual({ type: 'field' });
    expect(resolveDynamicValue({ type: 'bogus', source: 'x' }, context)).toEqual({
      type: 'bogus',
      source: 'x',
    });
  });

  it('walks the full path through entityData when the root segment is the entity type', () => {
    expect(resolveDynamicValue(createDynamicFieldValue('contact.first_name'), context)).toBe('Ann');
    expect(resolveDynamicValue(createDynamicFieldValue('contact.owner.name'), context)).toBe('Bob');
  });

  it('treats an unprefixed root segment as a related-entity lookup', () => {
    expect(resolveDynamicValue(createDynamicFieldValue('first_name', 'fb'), context)).toBe('fb');
    expect(resolveDynamicValue(createDynamicFieldValue('opportunity.name'), context)).toBe(
      'Big Deal'
    );
  });

  it('falls back when a field path does not resolve', () => {
    expect(resolveDynamicValue(createDynamicFieldValue('contact.missing', 'n/a'), context)).toBe(
      'n/a'
    );
    expect(
      resolveDynamicValue(createDynamicFieldValue('contact.missing.deep', 'n/a'), context)
    ).toBe('n/a');
    expect(resolveDynamicValue(createDynamicFieldValue('contact.missing'), context)).toBeNull();
  });

  it('prefers an explicit path over the source', () => {
    expect(
      resolveDynamicValue(
        { type: 'field', source: 'opportunity.name', path: 'contact.first_name' },
        context
      )
    ).toBe('Ann');
  });

  it('returns constant sources directly', () => {
    expect(resolveDynamicValue({ type: 'constant', source: 'fixed' }, context)).toBe('fixed');
  });

  it('resolves built-in variables and metadata, with a fallback', () => {
    expect(resolveDynamicValue({ type: 'variable', source: 'entity_id' }, context)).toBe('c-1');
    expect(resolveDynamicValue({ type: 'variable', source: 'current_org_id' }, context)).toBe(
      'org-1'
    );
    expect(
      resolveDynamicValue({ type: 'variable', source: 'run_id' }, {
        ...context,
        metadata: { run_id: 'r-9' },
      } as ConditionEvaluationContext)
    ).toBe('r-9');
    expect(
      resolveDynamicValue({ type: 'variable', source: 'unknown', fallback: 'fb' }, context)
    ).toBe('fb');
  });

  describe('function sources', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves now/today', () => {
      expect(resolveDynamicValue(createDynamicFunctionValue('now'), context)).toBe(
        '2026-06-15T12:00:00.000Z'
      );
      expect(resolveDynamicValue(createDynamicFunctionValue('today'), context)).toBe('2026-06-15');
    });

    it('resolves relative day offsets', () => {
      expect(
        resolveDynamicValue(createDynamicFunctionValue('days_ago', { days: 5 }), context)
      ).toBe('2026-06-10');
      expect(
        resolveDynamicValue(createDynamicFunctionValue('days_from_now', { days: 3 }), context)
      ).toBe('2026-06-18');
      expect(resolveDynamicValue(createDynamicFunctionValue('days_ago'), context)).toBe(
        '2026-06-15'
      );
    });

    it('resolves current user identifiers', () => {
      expect(resolveDynamicValue(createDynamicFunctionValue('current_user_id'), context)).toBe(
        'u-1'
      );
      expect(
        resolveDynamicValue(createDynamicFunctionValue('current_org_id'), {
          ...context,
          currentUser: undefined,
        })
      ).toBeNull();
    });

    it('computes entity age in days', () => {
      expect(resolveDynamicValue(createDynamicFunctionValue('entity_age_days'), context)).toBe(10);
      expect(
        resolveDynamicValue(createDynamicFunctionValue('entity_age_days'), {
          ...context,
          entityData: {},
        })
      ).toBeNull();
    });

    it('falls back for unknown functions', () => {
      expect(
        resolveDynamicValue(createDynamicFunctionValue('nope', undefined, 'fb'), context)
      ).toBe('fb');
      expect(resolveDynamicValue(createDynamicFunctionValue('nope'), context)).toBeNull();
    });
  });
});

describe('dynamic value factories', () => {
  it('builds field and function descriptors', () => {
    expect(createDynamicFieldValue('contact.email', 'none')).toEqual({
      type: 'field',
      source: 'contact.email',
      fallback: 'none',
    });
    expect(createDynamicFunctionValue('days_ago', { days: 2 })).toEqual({
      type: 'function',
      source: 'days_ago',
      params: { days: 2 },
      fallback: undefined,
    });
  });
});
