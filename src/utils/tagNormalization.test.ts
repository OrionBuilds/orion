import { describe, expect, it } from 'vitest';
import type { Tag } from '../types';
import { normalizeContactTags, normalizeContactsArray, normalizeTags } from './tagNormalization';

const tag = (id: string): Tag => ({ id, name: `tag-${id}` }) as Tag;

describe('normalizeTags', () => {
  it('returns an empty array for nullish or non-array input', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags('nope' as unknown as Tag[])).toEqual([]);
  });

  it('unwraps join-table rows shaped as { tag }', () => {
    expect(normalizeTags([{ tag: tag('1') }, { tag: tag('2') }])).toEqual([tag('1'), tag('2')]);
  });

  it('passes through already flat tags', () => {
    expect(normalizeTags([tag('1')])).toEqual([tag('1')]);
  });

  it('drops entries without a string id', () => {
    const rawTags = [tag('1'), { id: 5 }, {}] as unknown as Tag[];
    expect(normalizeTags(rawTags)).toEqual([tag('1')]);
  });
});

describe('normalizeContactTags', () => {
  it('passes through null and undefined contacts', () => {
    expect(normalizeContactTags(null)).toBeNull();
    expect(normalizeContactTags(undefined)).toBeUndefined();
  });

  it('normalizes the tags field without mutating the input', () => {
    const contact = { id: 'c-1', tags: [{ tag: tag('1') }] };
    const normalized = normalizeContactTags(contact);

    expect(normalized).toEqual({ id: 'c-1', tags: [tag('1')] });
    expect(contact.tags).toEqual([{ tag: tag('1') }]);
  });

  it('defaults a missing tags field to an empty array', () => {
    const contact: { id: string; tags?: unknown } = { id: 'c-1' };
    expect(normalizeContactTags(contact)).toEqual({ id: 'c-1', tags: [] });
  });
});

describe('normalizeContactsArray', () => {
  it('returns an empty array for nullish input', () => {
    expect(normalizeContactsArray(null)).toEqual([]);
    expect(normalizeContactsArray(undefined)).toEqual([]);
  });

  it('normalizes every contact in the list', () => {
    expect(normalizeContactsArray([{ tags: [{ tag: tag('1') }] }, { tags: [tag('2')] }])).toEqual([
      { tags: [tag('1')] },
      { tags: [tag('2')] },
    ]);
  });
});
