import DOMPurify from 'dompurify';

export const GATE_STATUS: Record<string, { label: string; tone: 'neutral' | 'good' | 'warn' | 'stop' }> = {
  open: { label: 'Upcoming', tone: 'neutral' },
  accepted: { label: 'Accepted', tone: 'good' },
  remediation: { label: 'Needs work', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'stop' },
};

export function gateStatus(status: string | null | undefined) {
  return GATE_STATUS[String(status ?? '')] ?? GATE_STATUS.open;
}

/** Only http(s) and mailto URLs are clickable. Returns the normalized URL or null. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || /\s/.test(v)) return null;
  try {
    const u = new URL(v);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const ALLOWED_TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'strong', 'b', 'em', 'i', 'u', 'a', 'blockquote', 'code', 'br', 'hr'];

let hookInstalled = false;
function ensureHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href');
      if (!safeUrl(href)) node.removeAttribute('href');
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  });
}

/** Strict allowlist: no styles, classes, ids, scripts, images. Links forced to rel=noopener. */
export function sanitizeCaioHtml(dirty: string): string {
  ensureHook();
  return DOMPurify.sanitize(dirty ?? '', {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'rel', 'target'],
    ALLOW_DATA_ATTR: false,
  });
}

export function truncateText(text: string, max = 160): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max).trimEnd() + '…', truncated: true } : { text, truncated: false };
}

export function formatCaioDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(cellToText).filter(Boolean).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return '';
  return String(value);
}

/** Print window with a minimal stylesheet. `html` must already be sanitized. */
export function printDocument(title: string, html: string): boolean {
  // Not 'noopener' in the features string: that makes window.open return null, so nothing could be written to it.
  // The window only ever shows content we wrote, and its opener link is cut straight away.
  const w = window.open('', '_blank');
  if (!w) return false;
  w.opener = null;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:Georgia,serif;max-width:760px;margin:32px auto;padding:0 16px;color:#111;line-height:1.5}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top}
</style></head><body><h1>${esc(title)}</h1>${html}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
  return true;
}
