import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const customValuesRows = vi.hoisted(() => ({ data: [] as Array<Record<string, string>> }));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve(customValuesRows),
      }),
    }),
  },
}));

const {
  buildComputedTokens,
  extractTokensFromText,
  getAvailableTokens,
  getUnresolvedTokens,
  resolveTokensInText,
  validateTemplate,
} = await import('./tokenResolver');

const context = {
  contact: {
    first_name: 'Ann',
    last_name: 'Lee',
    phone: '5551234567',
    email: '',
    city: 'Austin',
    address_line1: '1 Main St',
    state: 'TX',
    postal_code: '78701',
  },
  opportunity: { name: 'Big Deal', value: 1234.5, close_date: '2026-07-01T00:00:00Z' },
  user: { first_name: 'Bob', last_name: 'Ray' },
};

beforeEach(() => {
  customValuesRows.data = [];
});

describe('resolveTokensInText', () => {
  it('substitutes context tokens', async () => {
    await expect(
      resolveTokensInText('Hi {{contact.first_name}} at {{opportunity.name}}', 'org-1', context)
    ).resolves.toBe('Hi Ann at Big Deal');
  });

  it('uses org custom values for custom.* tokens, case-insensitively', async () => {
    customValuesRows.data = [{ key: 'Support_Email', value: 'help@acme.test' }];
    await expect(
      resolveTokensInText('Contact {{custom.support_email}}', 'org-1', context)
    ).resolves.toBe('Contact help@acme.test');
  });

  it('applies fallbacks and drops unresolved tokens by default', async () => {
    await expect(
      resolveTokensInText('Hello {{contact.nickname|friend}}', 'org-1', context)
    ).resolves.toBe('Hello friend');
    await expect(resolveTokensInText('Hello {{contact.nickname}}', 'org-1', context)).resolves.toBe(
      'Hello '
    );
  });

  it('preserves unresolved tokens when asked', async () => {
    await expect(
      resolveTokensInText('Hello {{contact.nickname}}', 'org-1', context, {
        preserveUnresolved: true,
      })
    ).resolves.toBe('Hello {{contact.nickname}}');
  });

  it('treats a |format: suffix as a fallback, returning the raw value when it resolves', async () => {
    await expect(
      resolveTokensInText('{{opportunity.value|format:currency}}', 'org-1', context)
    ).resolves.toBe('1234.5');
    await expect(
      resolveTokensInText('{{contact.city|format:uppercase}}', 'org-1', context)
    ).resolves.toBe('Austin');
  });

  it('emits the |format: suffix verbatim when the value is empty', async () => {
    await expect(
      resolveTokensInText('{{contact.email|format:lowercase}}', 'org-1', context)
    ).resolves.toBe('format:lowercase');
  });

  describe('date tokens', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves today, year, month, and day', async () => {
      await expect(
        resolveTokensInText('{{year}}/{{month}}/{{day}}', 'org-1', context)
      ).resolves.toBe('2026/June/15');
      await expect(
        resolveTokensInText('{{today}}', 'org-1', context, { dateFormat: 'YYYY-MM-DD' })
      ).resolves.toBe('2026-06-15');
      await expect(resolveTokensInText('{{now}}', 'org-1', context)).resolves.toContain('2026');
    });
  });
});

describe('getUnresolvedTokens', () => {
  it('classifies missing context, invalid paths, and empty values', () => {
    const unresolved = getUnresolvedTokens(
      '{{invoice.total}} {{contact.nickname}} {{contact.email}}',
      context,
      []
    );
    expect(unresolved).toEqual([
      { token: '{{invoice.total}}', reason: 'missing_context' },
      { token: '{{contact.nickname}}', reason: 'invalid_path' },
      { token: '{{contact.email}}', reason: 'missing_value' },
    ]);
  });

  it('reports unknown custom values but accepts known keys', () => {
    expect(getUnresolvedTokens('{{custom.Missing}}', context, ['known'])).toEqual([
      { token: '{{custom.Missing}}', reason: 'missing_value' },
    ]);
    expect(getUnresolvedTokens('{{custom.known}}', context, ['known'])).toEqual([]);
  });

  it('ignores tokens with fallbacks and date tokens', () => {
    expect(getUnresolvedTokens('{{contact.nickname|friend}} {{today}}', context, [])).toEqual([]);
  });

  it('resolves the base path of formatted tokens', () => {
    expect(getUnresolvedTokens('{{contact.first_name|format:uppercase}}', context, [])).toEqual([]);
  });
});

describe('extractTokensFromText', () => {
  it('returns unique tokens in order of appearance', () => {
    expect(
      extractTokensFromText('{{a.b}} then {{c.d}} then {{a.b}}')
    ).toEqual(['{{a.b}}', '{{c.d}}']);
  });

  it('returns nothing when there are no tokens', () => {
    expect(extractTokensFromText('plain text')).toEqual([]);
  });
});

describe('getAvailableTokens', () => {
  it('includes only the requested categories plus date tokens', async () => {
    const tokens = await getAvailableTokens('org-1', ['contact']);
    const categories = new Set(tokens.map((t) => t.category));
    expect(categories).toEqual(new Set(['contact', 'date']));
    expect(tokens.map((t) => t.token)).toContain('{{contact.first_name}}');
  });

  it('includes every requested entity category and org custom values', async () => {
    customValuesRows.data = [{ key: 'support_email', name: 'Support Email' }];
    const tokens = await getAvailableTokens('org-1', [
      'contact',
      'opportunity',
      'appointment',
      'user',
      'organization',
    ]);
    expect(new Set(tokens.map((t) => t.category))).toEqual(
      new Set(['contact', 'opportunity', 'appointment', 'user', 'organization', 'date', 'custom'])
    );
    expect(tokens.map((t) => t.token)).toContain('{{custom.support_email}}');
  });
});

describe('validateTemplate', () => {
  const available = ['{{contact.first_name}}', '{{contact.email}}'];

  it('accepts known tokens, category siblings, and date tokens', () => {
    expect(validateTemplate('{{contact.first_name}} {{today}}', available)).toEqual({
      valid: true,
      invalidTokens: [],
    });
    expect(validateTemplate('{{contact.last_name}}', available).valid).toBe(true);
    expect(validateTemplate('{{contact.first_name|format:uppercase}}', available).valid).toBe(true);
  });

  it('rejects tokens from unknown categories', () => {
    expect(validateTemplate('{{invoice.total}}', available)).toEqual({
      valid: false,
      invalidTokens: ['{{invoice.total}}'],
    });
    expect(validateTemplate('{{invoice.total|format:currency}}', available).invalidTokens).toEqual([
      '{{invoice.total|format:currency}}',
    ]);
  });
});

describe('buildComputedTokens', () => {
  it('derives full name and address from the contact', () => {
    expect(buildComputedTokens(context)).toEqual({
      'contact.full_name': 'Ann Lee',
      'contact.full_address': '1 Main St, Austin, TX, 78701',
      'user.full_name': 'Bob Ray',
    });
  });

  it('omits keys with no underlying data', () => {
    expect(buildComputedTokens({ contact: { email: 'a@b.test' } })).toEqual({});
    expect(buildComputedTokens({})).toEqual({});
  });
});
