import { describe, expect, it } from 'vitest';
import {
  FIELD_REGISTRY,
  getFieldByKey,
  getFieldCategories,
  getFieldsByCategory,
  searchFields,
} from './conditionFields';

describe('FIELD_REGISTRY', () => {
  it('has unique keys prefixed with their category', () => {
    const keys = FIELD_REGISTRY.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(FIELD_REGISTRY.every((f) => f.key.startsWith(`${f.category}.`))).toBe(true);
  });

  it('gives select fields either static options or a dynamic source', () => {
    const selects = FIELD_REGISTRY.filter((f) => f.type === 'select');
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((f) => Boolean(f.options?.length) || Boolean(f.dynamicOptionsSource))).toBe(
      true
    );
  });
});

describe('getFieldsByCategory', () => {
  it('returns only fields in the requested category', () => {
    const fields = getFieldsByCategory('opportunity');
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => f.category === 'opportunity')).toBe(true);
    expect(fields.map((f) => f.key)).toContain('opportunity.value_amount');
  });

  it('returns nothing for a category with no registered fields', () => {
    expect(getFieldsByCategory('custom_field')).toEqual([]);
  });
});

describe('getFieldByKey', () => {
  it('looks up a field definition by exact key', () => {
    expect(getFieldByKey('contact.email')).toMatchObject({ label: 'Email', type: 'email' });
  });

  it('returns undefined for unknown keys and is case-sensitive', () => {
    expect(getFieldByKey('contact.unknown')).toBeUndefined();
    expect(getFieldByKey('Contact.Email')).toBeUndefined();
  });
});

describe('getFieldCategories', () => {
  it('lists every registry category plus custom fields', () => {
    const categories = getFieldCategories();
    const categoryKeys = new Set(categories.map((c) => c.key));
    for (const field of FIELD_REGISTRY) {
      expect(categoryKeys.has(field.category)).toBe(true);
    }
    expect(categoryKeys.has('custom_field')).toBe(true);
    expect(categories.every((c) => c.label.length > 0)).toBe(true);
  });
});

describe('searchFields', () => {
  it('matches on label and key, case-insensitively', () => {
    expect(searchFields('lead score').map((f) => f.key)).toEqual(['contact.lead_score']);
    expect(searchFields('CONTACT.PHONE').map((f) => f.key)).toEqual(['contact.phone']);
  });

  it('restricts results to the requested categories', () => {
    const scoped = searchFields('status', ['task', 'invoice']);
    expect(scoped.map((f) => f.key)).toEqual(['invoice.status', 'task.status']);
  });

  it('ignores an empty category filter', () => {
    expect(searchFields('due_date', []).map((f) => f.key)).toEqual([
      'invoice.due_date',
      'task.due_date',
    ]);
  });

  it('returns the whole registry for an empty query and nothing for a miss', () => {
    expect(searchFields('')).toHaveLength(FIELD_REGISTRY.length);
    expect(searchFields('no-such-field')).toEqual([]);
  });
});
