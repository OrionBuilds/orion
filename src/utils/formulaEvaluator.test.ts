import { describe, expect, it } from 'vitest';
import { evalFormula, evalMath, formatComputed } from './formulaEvaluator';

describe('evalMath', () => {
  it('evaluates arithmetic with operator precedence and parens', () => {
    expect(evalMath('1 + 2 * 3')).toBe(7);
    expect(evalMath('(1 + 3) / 2')).toBe(2);
    expect(evalMath('2.5 * 4')).toBe(10);
    expect(evalMath('-5 + 1')).toBe(-4);
  });

  it('strips characters outside the math allowlist before evaluating', () => {
    expect(evalMath('2 + alert(1)')).toBe(evalMath('2 + 1'));
    expect(evalMath('1 + 1; process.exit()')).toBeNull();
  });

  it('returns null for empty, invalid, or non-finite expressions', () => {
    expect(evalMath('')).toBeNull();
    expect(evalMath('abc')).toBeNull();
    expect(evalMath('1 +')).toBeNull();
    expect(evalMath('1 / 0')).toBeNull();
  });
});

describe('evalFormula', () => {
  it('substitutes field placeholders with numeric values', () => {
    expect(evalFormula('{a} + {b}', { a: 2, b: 3 })).toBe(5);
    expect(evalFormula('{sqft} * 12 + 250', { sqft: 10 })).toBe(370);
  });

  it('trims placeholder whitespace when looking up values', () => {
    expect(evalFormula('{ a } * 2', { a: 4 })).toBe(8);
  });

  it('treats missing, empty, and non-numeric values as zero', () => {
    expect(evalFormula('{a} + 1', {})).toBe(1);
    expect(evalFormula('{a} + 1', { a: null })).toBe(1);
    expect(evalFormula('{a} + 1', { a: '' })).toBe(1);
    expect(evalFormula('{a} + 1', { a: { nested: true } })).toBe(1);
    expect(evalFormula('{a} + 1', { a: Number.POSITIVE_INFINITY })).toBe(1);
  });

  it('parses numeric strings with currency symbols and separators', () => {
    expect(evalFormula('{price} * 2', { price: '$12.50' })).toBe(25);
    expect(evalFormula('{delta} + 1', { delta: '-4' })).toBe(-3);
  });

  it('returns null when the formula is missing', () => {
    expect(evalFormula(undefined, { a: 1 })).toBeNull();
    expect(evalFormula('', { a: 1 })).toBeNull();
  });
});

describe('formatComputed', () => {
  it('returns an empty string for null values', () => {
    expect(formatComputed(null)).toBe('');
  });

  it('applies decimals and currency prefix', () => {
    expect(formatComputed(12.345, { decimals: 2 })).toBe('12.35');
    expect(formatComputed(12, { currency: '$', decimals: 2 })).toBe('$12.00');
    expect(formatComputed(12.5)).toBe('12.5');
  });
});
