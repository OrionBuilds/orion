import { describe, expect, it } from 'vitest';
import type { Condition, ConditionGroup, OperatorType } from '../types/conditions';
import { getValidationSummary, validateConditions } from './conditionValidator';

function condition(overrides: Partial<Condition> = {}): Condition {
  return {
    id: 'c-1',
    field: 'contact.first_name',
    operator: 'contains',
    value: 'ann',
    ...overrides,
  };
}

function group(overrides: Partial<ConditionGroup> = {}): ConditionGroup {
  return {
    id: 'g-1',
    logicalOperator: 'and',
    conditions: [condition()],
    ...overrides,
  };
}

function codes(result: { errors: Array<{ code: string }> }): string[] {
  return result.errors.map((e) => e.code);
}

describe('validateConditions', () => {
  it('accepts a well-formed group', () => {
    const result = validateConditions(group());
    expect(result).toMatchObject({ valid: true, errors: [], warnings: [] });
  });

  it('flags a missing group id and an invalid logical operator', () => {
    const result = validateConditions(
      group({ id: '', logicalOperator: 'xor' as ConditionGroup['logicalOperator'] })
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining(['MISSING_GROUP_ID', 'INVALID_LOGICAL_OPERATOR'])
    );
    expect(result.valid).toBe(false);
  });

  it('warns about an empty group without failing validation', () => {
    const result = validateConditions(group({ conditions: [] }));
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(['EMPTY_GROUP']);
  });

  it('validates nested groups recursively', () => {
    const result = validateConditions(
      group({
        conditions: [group({ id: 'g-2', conditions: [condition({ id: 'c-2', field: '' })] })],
      })
    );
    expect(codes(result)).toEqual(['MISSING_FIELD']);
  });

  it('flags conditions missing an id, field, or operator', () => {
    expect(codes(validateConditions(group({ conditions: [condition({ id: '' })] })))).toEqual([
      'MISSING_CONDITION_ID',
    ]);
    expect(codes(validateConditions(group({ conditions: [condition({ field: '' })] })))).toEqual([
      'MISSING_FIELD',
    ]);
    expect(
      codes(
        validateConditions(
          group({ conditions: [condition({ operator: '' as OperatorType })] })
        )
      )
    ).toEqual(['MISSING_OPERATOR']);
  });

  it('flags unknown fields and unknown operators', () => {
    expect(
      codes(validateConditions(group({ conditions: [condition({ field: 'contact.nope' })] })))
    ).toEqual(['UNKNOWN_FIELD']);
    expect(
      codes(
        validateConditions(
          group({ conditions: [condition({ operator: 'nope' as OperatorType })] })
        )
      )
    ).toEqual(['UNKNOWN_OPERATOR']);
  });

  it('warns rather than errors for custom field references', () => {
    const result = validateConditions(
      group({ conditions: [condition({ field: 'custom_field.shirt_size' })] })
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(['CUSTOM_FIELD_REFERENCE']);
  });

  it('rejects an operator that does not apply to the field type', () => {
    const result = validateConditions(
      group({ conditions: [condition({ field: 'contact.lead_score', operator: 'contains' })] })
    );
    expect(codes(result)).toContain('INVALID_OPERATOR_FOR_TYPE');
  });

  it('requires values for operators that declare them', () => {
    expect(
      codes(validateConditions(group({ conditions: [condition({ value: '' })] })))
    ).toEqual(['MISSING_VALUE']);
    expect(
      codes(
        validateConditions(
          group({
            conditions: [
              condition({ field: 'contact.lead_score', operator: 'between', value: 1 }),
            ],
          })
        )
      )
    ).toEqual(['MISSING_SECONDARY_VALUE']);
  });

  it('accepts operators that need no value', () => {
    const result = validateConditions(
      group({ conditions: [condition({ operator: 'is_empty', value: undefined })] })
    );
    expect(result.valid).toBe(true);
  });
});

describe('getValidationSummary', () => {
  it('reports a clean result', () => {
    expect(getValidationSummary(validateConditions(group()))).toBe('Conditions are valid');
  });

  it('pluralizes error and warning counts', () => {
    expect(
      getValidationSummary({
        valid: false,
        errors: [{ conditionId: 'c-1', field: 'f', message: 'm', code: 'X' }],
        warnings: [],
      })
    ).toBe('1 error');

    expect(
      getValidationSummary({
        valid: false,
        errors: [
          { conditionId: 'c-1', field: 'f', message: 'm', code: 'X' },
          { conditionId: 'c-2', field: 'f', message: 'm', code: 'X' },
        ],
        warnings: [
          { conditionId: 'c-3', field: 'f', message: 'm', code: 'W' },
          { conditionId: 'c-4', field: 'f', message: 'm', code: 'W' },
        ],
      })
    ).toBe('2 errors, 2 warnings');
  });
});
