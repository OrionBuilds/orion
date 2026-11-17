import { describe, expect, it } from 'vitest';
import { calculateSMSSegments, collectPhoneNumbers, formatPhoneForDisplay, normalizePhoneNumber } from './phoneUtils';

describe('collectPhoneNumbers', () => {
  it('drops blanks and too-short values', () => {
    expect(collectPhoneNumbers([null, undefined, '', '   ', '123'])).toEqual([]);
  });

  it('de-duplicates by normalized number, keeping the first spelling', () => {
    expect(collectPhoneNumbers(['(555) 123-4567', '+15551234567', '555.123.4567', '+442012345678']))
      .toEqual(['(555) 123-4567', '+442012345678']);
  });
});

describe('normalizePhoneNumber', () => {
  it('adds the US country code to 10-digit numbers', () => {
    expect(normalizePhoneNumber('5551234567')).toBe('+15551234567');
    expect(normalizePhoneNumber('(555) 123-4567')).toBe('+15551234567');
  });

  it('prefixes 11-digit numbers that already start with 1', () => {
    expect(normalizePhoneNumber('15551234567')).toBe('+15551234567');
  });

  it('leaves already normalized E.164 numbers untouched', () => {
    expect(normalizePhoneNumber('+445551234567')).toBe('+445551234567');
  });

  it('prefixes other digit counts with + after stripping formatting', () => {
    expect(normalizePhoneNumber('44 20 1234 5678')).toBe('+442012345678');
  });
});

describe('formatPhoneForDisplay', () => {
  it('formats US numbers as (AAA) NNN-NNNN', () => {
    expect(formatPhoneForDisplay('5551234567')).toBe('(555) 123-4567');
    expect(formatPhoneForDisplay('+15551234567')).toBe('(555) 123-4567');
  });

  it('returns the original input for non-US numbers', () => {
    expect(formatPhoneForDisplay('+442012345678')).toBe('+442012345678');
  });
});

describe('calculateSMSSegments', () => {
  it('counts a single GSM-7 segment up to 160 characters', () => {
    expect(calculateSMSSegments('hello')).toEqual({ segments: 1, encoding: 'GSM-7' });
    expect(calculateSMSSegments('a'.repeat(160))).toEqual({ segments: 1, encoding: 'GSM-7' });
  });

  it('splits longer GSM-7 bodies into 153-character segments', () => {
    expect(calculateSMSSegments('a'.repeat(161))).toEqual({ segments: 2, encoding: 'GSM-7' });
    expect(calculateSMSSegments('a'.repeat(306))).toEqual({ segments: 2, encoding: 'GSM-7' });
    expect(calculateSMSSegments('a'.repeat(307))).toEqual({ segments: 3, encoding: 'GSM-7' });
  });

  it('uses UCS-2 thresholds when the body has non-GSM characters', () => {
    expect(calculateSMSSegments('emoji 🎉')).toEqual({ segments: 1, encoding: 'UCS-2' });
    expect(calculateSMSSegments(`🎉${'a'.repeat(70)}`)).toEqual({ segments: 2, encoding: 'UCS-2' });
  });
});
