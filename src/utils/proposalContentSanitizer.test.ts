import { describe, expect, it } from 'vitest';
import { sanitizeProposalContent } from './proposalContentSanitizer';

describe('sanitizeProposalContent', () => {
  it('returns an empty string for empty or non-string input', () => {
    expect(sanitizeProposalContent('')).toBe('');
    expect(sanitizeProposalContent(null as unknown as string)).toBe('');
    expect(sanitizeProposalContent(123 as unknown as string)).toBe('');
  });

  it('passes HTML content through untouched', () => {
    expect(sanitizeProposalContent('  <p>Scope of work</p>  ')).toBe('<p>Scope of work</p>');
  });

  it('renders a JSON section array as HTML', () => {
    const raw = JSON.stringify([
      { title: 'Scope', content: '<p>Build it</p>' },
      { content: '<p>No title</p>' },
    ]);
    expect(sanitizeProposalContent(raw)).toBe(
      '<h3>Scope</h3><p>Build it</p>\n<p>No title</p>'
    );
  });

  it('strips markdown code fences before parsing JSON', () => {
    const raw = '```json\n[{"title":"Pricing","content":"<p>$100</p>"}]\n```';
    expect(sanitizeProposalContent(raw)).toBe('<h3>Pricing</h3><p>$100</p>');
  });

  it('unwraps an object with a sections array or a content string', () => {
    expect(
      sanitizeProposalContent('{"title":"x","sections":[{"title":"A","content":"<p>a</p>"}]}')
    ).toBe('<h3>A</h3><p>a</p>');
    expect(sanitizeProposalContent('{"title":"x","content":"<p>body</p>"}')).toBe('<p>body</p>');
  });

  it('recovers a section array embedded in malformed JSON', () => {
    const raw = '{"section_type":"pricing", junk [{"title":"T","content":"<p>c</p>"}] trailing';
    expect(sanitizeProposalContent(raw)).toBe('<h3>T</h3><p>c</p>');
  });

  it('returns the original text when JSON-looking content cannot be unwrapped', () => {
    const raw = '{"section_type":"pricing"} not really json';
    expect(sanitizeProposalContent(raw)).toBe(raw);
  });

  it('returns fenced non-JSON content with the fences stripped', () => {
    expect(sanitizeProposalContent('```\n<p>fenced html</p>\n```')).toBe('<p>fenced html</p>');
  });
});
