import { describe, expect, it } from 'vitest';
import {
  buildMentionSnippet,
  buildMentionToken,
  mentionsToPlainText,
  parseMentions,
} from './mentionTokens';

describe('parseMentions', () => {
  it('returns an empty array for empty text or text without tokens', () => {
    expect(parseMentions('')).toEqual([]);
    expect(parseMentions('no mentions here')).toEqual([]);
  });

  it('parses typed tokens with their offsets', () => {
    const text = 'ping @[Acme Corp](contact:c-1) about @[Deal](opportunity:o-2)';
    const mentions = parseMentions(text);

    expect(mentions.map((m) => ({ type: m.type, id: m.id, displayName: m.displayName }))).toEqual([
      { type: 'contact', id: 'c-1', displayName: 'Acme Corp' },
      { type: 'opportunity', id: 'o-2', displayName: 'Deal' },
    ]);
    expect(text.slice(mentions[0].index, mentions[0].index + mentions[0].raw.length)).toBe(
      mentions[0].raw
    );
  });

  it('treats a payload without a type prefix as a legacy user mention', () => {
    expect(parseMentions('hi @[Dana](user-123)')[0]).toMatchObject({
      type: 'user',
      id: 'user-123',
      displayName: 'Dana',
    });
  });

  it('skips tokens with an unknown type or an empty id', () => {
    expect(parseMentions('@[X](invoice:i-1)')).toEqual([]);
    expect(parseMentions('@[X](contact:)')).toEqual([]);
  });
});

describe('buildMentionToken', () => {
  it('omits the type prefix for user mentions', () => {
    expect(buildMentionToken('user', 'u-1', 'Dana')).toBe('@[Dana](u-1)');
  });

  it('includes the type prefix for other entity types', () => {
    expect(buildMentionToken('project', 'p-1', 'Website')).toBe('@[Website](project:p-1)');
  });

  it('round-trips through parseMentions', () => {
    const token = buildMentionToken('proposal', 'pr-9', 'Q3 Proposal');
    expect(parseMentions(token)[0]).toMatchObject({ type: 'proposal', id: 'pr-9' });
  });
});

describe('mentionsToPlainText', () => {
  it('reduces tokens to their display names', () => {
    expect(mentionsToPlainText('cc @[Acme Corp](contact:c-1) now')).toBe('cc @Acme Corp now');
  });

  it('passes through empty input', () => {
    expect(mentionsToPlainText('')).toBe('');
  });
});

describe('buildMentionSnippet', () => {
  it('returns the whole text in plain form when shorter than the window', () => {
    const text = 'talk to @[Acme Corp](contact:c-1) today';
    const mention = parseMentions(text)[0];
    expect(buildMentionSnippet(text, mention.index, mention.raw.length)).toBe(
      'talk to @Acme Corp today'
    );
  });

  it('windows long text around the mention and adds ellipses', () => {
    const filler = 'x'.repeat(300);
    const text = `${filler} @[Acme Corp](contact:c-1) ${filler}`;
    const mention = parseMentions(text)[0];
    const snippet = buildMentionSnippet(text, mention.index, mention.raw.length, 100);

    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('@Acme Corp');
    expect(snippet.length).toBeLessThanOrEqual(102);
  });

  it('clamps the window to the start of the text', () => {
    const text = `@[Acme Corp](contact:c-1) ${'y'.repeat(300)}`;
    const mention = parseMentions(text)[0];
    const snippet = buildMentionSnippet(text, mention.index, mention.raw.length, 100);

    expect(snippet.startsWith('@Acme Corp')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });
});
