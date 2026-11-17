import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitizeHtml';

describe('sanitizeHtml', () => {
  it('keeps allowed formatting, tables, and links', () => {
    expect(sanitizeHtml('<h2>Title</h2><p><strong>bold</strong> text</p>')).toBe(
      '<h2>Title</h2><p><strong>bold</strong> text</p>'
    );
    expect(sanitizeHtml('<a href="https://example.com" target="_blank">link</a>')).toBe(
      '<a href="https://example.com" target="_blank">link</a>'
    );
    expect(sanitizeHtml('<table><tr><td colspan="2">cell</td></tr></table>')).toContain(
      'colspan="2"'
    );
  });

  it('strips script tags and their content', () => {
    expect(sanitizeHtml('<p>safe</p><script>alert(1)</script>')).toBe('<p>safe</p>');
  });

  it('strips event handler attributes', () => {
    expect(sanitizeHtml('<div onclick="steal()">text</div>')).toBe('<div>text</div>');
    expect(sanitizeHtml('<img src="x" onerror="steal()">')).not.toContain('onerror');
  });

  it('drops disallowed tags such as iframe, form, and style', () => {
    expect(sanitizeHtml('<iframe src="https://evil.test"></iframe>')).toBe('');
    expect(sanitizeHtml('<form><input name="a"></form>')).toBe('');
    expect(sanitizeHtml('<style>body{display:none}</style><p>x</p>')).toBe('<p>x</p>');
  });

  it('removes data attributes', () => {
    expect(sanitizeHtml('<span data-secret="1">x</span>')).toBe('<span>x</span>');
  });

  it('passes plain text through unchanged', () => {
    expect(sanitizeHtml('just text')).toBe('just text');
    expect(sanitizeHtml('')).toBe('');
  });
});
