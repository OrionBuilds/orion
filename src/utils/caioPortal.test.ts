import { describe, it, expect } from 'vitest';
import { gateStatus, safeUrl, sanitizeCaioHtml, truncateText, cellToText } from './caioPortal';

describe('gateStatus', () => {
  it('maps statuses to client labels', () => {
    expect(gateStatus('open').label).toBe('Upcoming');
    expect(gateStatus('accepted').label).toBe('Accepted');
    expect(gateStatus('remediation').label).toBe('Needs work');
    expect(gateStatus('stopped').label).toBe('Stopped');
  });
  it('falls back to Upcoming for unknown', () => {
    expect(gateStatus('weird').label).toBe('Upcoming');
    expect(gateStatus(null).label).toBe('Upcoming');
  });
});

describe('safeUrl', () => {
  it('allows http/https/mailto only', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,hi')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(42)).toBeNull();
  });
});

describe('sanitizeCaioHtml', () => {
  it('strips scripts, styles, classes, handlers, images', () => {
    const out = sanitizeCaioHtml('<h2 class="x" style="color:red" onclick="a()">T</h2><script>alert(1)</script><img src=x onerror=a()><p>ok</p>');
    expect(out).toBe('<h2>T</h2><p>ok</p>');
  });
  it('keeps tables and forces rel on links, drops unsafe hrefs', () => {
    const out = sanitizeCaioHtml('<table><tbody><tr><td><a href="https://e.com">l</a><a href="javascript:x()">b</a></td></tr></tbody></table>');
    expect(out).toContain('<table>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('javascript:');
  });
  it('handles empty', () => {
    expect(sanitizeCaioHtml('')).toBe('');
  });
});

describe('text helpers', () => {
  it('truncates long text', () => {
    expect(truncateText('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(truncateText('a'.repeat(20), 5).truncated).toBe(true);
  });
  it('cellToText', () => {
    expect(cellToText(null)).toBe('');
    expect(cellToText(true)).toBe('Yes');
    expect(cellToText(['a', 'b'])).toBe('a, b');
    expect(cellToText({ a: 1 })).toBe('');
  });
});
