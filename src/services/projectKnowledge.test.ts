import { describe, it, expect } from 'vitest';
import { parseCovers } from './projectKnowledge';

describe('parseCovers', () => {
  it('splits lines, trims and drops blanks', () => {
    expect(parseCovers(' src/api/** \n\n  web/*.ts\n')).toEqual(['src/api/**', 'web/*.ts']);
    expect(parseCovers('')).toEqual([]);
  });
});
