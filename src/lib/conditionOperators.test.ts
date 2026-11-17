import { describe, expect, it } from 'vitest';
import type { OperatorType } from '../types/conditions';
import {
  OPERATOR_REGISTRY,
  getDefaultOperatorForType,
  getOperatorByKey,
  getOperatorsByFieldType,
  isOperatorValidForType,
  operatorRequiresSecondValue,
  operatorRequiresValue,
} from './conditionOperators';

describe('OPERATOR_REGISTRY', () => {
  it('has unique operator keys', () => {
    const keys = OPERATOR_REGISTRY.map((op) => op.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('getOperatorsByFieldType', () => {
  it('only returns operators applicable to the field type', () => {
    const textOps = getOperatorsByFieldType('text');
    expect(textOps.length).toBeGreaterThan(0);
    expect(textOps.every((op) => op.applicableTypes.includes('text'))).toBe(true);
    expect(textOps.map((op) => op.key)).toContain('contains');
    expect(textOps.map((op) => op.key)).not.toContain('has_tag');
  });

  it('returns tag operators only for the tags type', () => {
    expect(getOperatorsByFieldType('tags').map((op) => op.key)).toContain('has_all_tags');
  });
});

describe('getOperatorByKey', () => {
  it('finds a known operator', () => {
    expect(getOperatorByKey('between')).toMatchObject({
      key: 'between',
      requiresValue: true,
      requiresSecondValue: true,
    });
  });

  it('returns undefined for an unknown operator', () => {
    expect(getOperatorByKey('not_an_operator' as OperatorType)).toBeUndefined();
  });
});

describe('isOperatorValidForType', () => {
  it('validates operator/field-type pairings', () => {
    expect(isOperatorValidForType('contains', 'text')).toBe(true);
    expect(isOperatorValidForType('contains', 'number')).toBe(false);
    expect(isOperatorValidForType('date_is_today', 'date')).toBe(true);
  });

  it('returns false for unknown operators', () => {
    expect(isOperatorValidForType('bogus' as OperatorType, 'text')).toBe(false);
  });
});

describe('getDefaultOperatorForType', () => {
  it('returns the mapped default per field type', () => {
    expect(getDefaultOperatorForType('text')).toBe('contains');
    expect(getDefaultOperatorForType('tags')).toBe('has_tag');
    expect(getDefaultOperatorForType('currency')).toBe('greater_than');
  });

  it('produces a default that is valid for the type', () => {
    const type = 'multi_select';
    expect(isOperatorValidForType(getDefaultOperatorForType(type), type)).toBe(true);
  });
});

describe('operator value requirements', () => {
  it('reports whether a value is required', () => {
    expect(operatorRequiresValue('equals')).toBe(true);
    expect(operatorRequiresValue('is_empty')).toBe(false);
  });

  it('defaults to requiring a value for unknown operators', () => {
    expect(operatorRequiresValue('bogus' as OperatorType)).toBe(true);
  });

  it('reports whether a second value is required', () => {
    expect(operatorRequiresSecondValue('between')).toBe(true);
    expect(operatorRequiresSecondValue('equals')).toBe(false);
    expect(operatorRequiresSecondValue('bogus' as OperatorType)).toBe(false);
  });
});
