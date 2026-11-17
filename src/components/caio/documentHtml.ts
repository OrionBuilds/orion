/**
 * Pure helpers for the CAIO document editor and templates admin: sanitizing, display-only attributes, table row
 * editing, .docx filename mapping, grouping templates by milestone and the print page. DOM based (jsdom in tests).
 */
import DOMPurify from 'dompurify';
import { unresolvedPlaceholders, type CaioTemplateRow } from '../../services/caio';
import { COMPANY } from '../public-document/documentTheme';

const ALLOWED_TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'strong', 'b', 'em', 'i', 'u', 'a', 'blockquote', 'code', 'br', 'hr', 'span'];
const ALLOWED_ATTR = ['href', 'rel', 'colspan', 'rowspan'];

/** Display-only attribute put on unresolved placeholder nodes in the live editor; never saved. */
export const PH_ATTR = 'data-ph';
const PH_TEXT = /^\[[A-Z0-9][A-Z0-9 /&'.,()-]*\]$/;

/** Browsers wrap lines in <div> when editing; the stored format uses <p>. */
function divsToParagraphs(root: Element): void {
  root.querySelectorAll('div').forEach((div) => {
    const p = root.ownerDocument.createElement('p');
    while (div.firstChild) p.appendChild(div.firstChild);
    div.replaceWith(p);
  });
}

/** Strip display-only attributes (highlighting) from a DOM tree in place. */
export function stripDisplayAttrs(root: Element): void {
  root.querySelectorAll(`[${PH_ATTR}]`).forEach((el) => el.removeAttribute(PH_ATTR));
}

/** The four data- attributes of an auto-filled value (`<mark data-auto ...>`); allowed on <mark> in the editor only. */
export const MARK_ATTRS = ['data-auto', 'data-resolver', 'data-conf', 'data-ref'] as const;

function cleanDoc(html: string, keepMarks: boolean): string {
  if (!html) return '';
  // parse inertly (DOMParser never loads images or runs handlers), fix up, then sanitize the result
  const parsed = new DOMParser().parseFromString(html, 'text/html').body;
  divsToParagraphs(parsed);
  stripDisplayAttrs(parsed);
  const clean = document.createElement('div');
  clean.innerHTML = keepMarks
    ? DOMPurify.sanitize(parsed.innerHTML, { ALLOWED_TAGS: [...ALLOWED_TAGS, 'mark'], ALLOWED_ATTR: [...ALLOWED_ATTR, ...MARK_ATTRS, 'data-rec'], ADD_URI_SAFE_ATTR: ['data-ref', 'data-rec'], ALLOW_DATA_ATTR: false })
    : DOMPurify.sanitize(parsed.innerHTML, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
  if (keepMarks) {
    // data- attributes only on <mark>, only the four, and a mark without data-auto is just text; resolver/conf are enums
    clean.querySelectorAll('*').forEach((el) => {
      const isMark = el.tagName === 'MARK';
      Array.from(el.attributes).forEach((a) => {
        // data-rec marks a table/row the engine expanded from a register record (kept so a regenerate does not expand it twice)
        const recOk = a.name === 'data-rec' && ['TABLE', 'TR'].includes(el.tagName) && /^[a-z_]+\/[A-Za-z0-9._-]+$/.test(a.value);
        if (a.name.startsWith('data-') && !recOk && !(isMark && (MARK_ATTRS as readonly string[]).includes(a.name))) el.removeAttribute(a.name);
      });
    });
    clean.querySelectorAll('mark').forEach((m) => {
      if (!m.hasAttribute('data-auto')) { m.replaceWith(...Array.from(m.childNodes)); return; }
      if (!['fact', 'engagement', 'computed', 'register', 'llm'].includes(m.getAttribute('data-resolver') ?? '')) m.removeAttribute('data-resolver');
      if (!['high', 'medium', 'low'].includes(m.getAttribute('data-conf') ?? '')) m.removeAttribute('data-conf');
    });
  }
  clean.querySelectorAll('a').forEach((a) => { a.setAttribute('rel', 'noopener noreferrer'); });
  return clean.innerHTML;
}

/** The only HTML we store or render: allow-listed tags, href/rel/colspan/rowspan, nothing else. Auto-fill marks become plain text. */
export function sanitizeDocHtml(html: string): string {
  return cleanDoc(html, false);
}

/** Editor path: as sanitizeDocHtml, plus <mark> carrying only data-auto / data-resolver / data-conf / data-ref. */
export function sanitizeEditorHtml(html: string): string {
  return cleanDoc(html, true);
}

/** Serialize the live editor surface for saving: display attributes removed, then sanitized. */
export function editorHtml(surface: HTMLElement): string {
  const clone = surface.cloneNode(true) as HTMLElement;
  stripDisplayAttrs(clone);
  return sanitizeEditorHtml(clone.innerHTML);
}

/** Mark every unresolved bold [PLACEHOLDER] in the live DOM (display-only; see editorHtml). Returns how many. */
export function markPlaceholders(surface: HTMLElement): number {
  let n = 0;
  surface.querySelectorAll('strong, b').forEach((el) => {
    const hit = PH_TEXT.test((el.textContent ?? '').trim());
    if (hit) { n++; if (!el.hasAttribute(PH_ATTR)) el.setAttribute(PH_ATTR, ''); }
    else if (el.hasAttribute(PH_ATTR)) el.removeAttribute(PH_ATTR);
  });
  return n;
}

/** The live <mark> of one auto-filled value (data-auto is the exact id, e.g. `RISK ID#2`). */
export function findMarkNode(surface: HTMLElement, id: string): HTMLElement | null {
  return Array.from(surface.querySelectorAll<HTMLElement>('mark[data-auto]')).find((el) => el.getAttribute('data-auto') === id) ?? null;
}

/** The nth (0-based) live node of one placeholder prompt. */
export function findPlaceholderNode(surface: HTMLElement, name: string, nth = 0): HTMLElement | null {
  const hits = Array.from(surface.querySelectorAll<HTMLElement>('strong, b')).filter((el) => (el.textContent ?? '').trim() === `[${name}]`);
  return hits[nth] ?? null;
}

// ── table rows ──────────────────────────────────────────────────────────────────────────────

/** Insert an empty copy of a row below it. A header row gets its body row at the top of the table body. */
export function addRowBelow(tr: HTMLTableRowElement): HTMLTableRowElement {
  const doc = tr.ownerDocument;
  const row = doc.createElement('tr');
  Array.from(tr.cells).forEach((cell) => {
    const td = doc.createElement('td');
    const span = cell.getAttribute('colspan');
    if (span) td.setAttribute('colspan', span);
    td.appendChild(doc.createElement('br'));
    row.appendChild(td);
  });
  const section = tr.parentElement;
  if (section && section.tagName === 'THEAD') {
    const table = section.parentElement as HTMLTableElement;
    let body = table.tBodies[0];
    if (!body) { body = doc.createElement('tbody'); table.appendChild(body); }
    body.insertBefore(row, body.firstChild);
  } else {
    tr.after(row);
  }
  return row;
}

/** Remove a row. The only row of a table stays (delete the content instead). */
export function deleteRow(tr: HTMLTableRowElement): boolean {
  const table = tr.closest('table');
  if (!table || table.rows.length <= 1) return false;
  tr.remove();
  return true;
}

/** The table row containing a node, but only inside the given editor surface. */
export function rowOf(node: Node | null, surface: HTMLElement): HTMLTableRowElement | null {
  const el = node && node.nodeType === 1 ? (node as Element) : node?.parentElement ?? null;
  const tr = el?.closest('tr') ?? null;
  return tr && surface.contains(tr) ? (tr as HTMLTableRowElement) : null;
}

// ── .docx import ────────────────────────────────────────────────────────────────────────────

/** "07 Pilot Charter.docx" -> 7. Only a two-digit prefix counts. */
export function templateNumberFromFilename(name: string): number | null {
  const m = /^\s*(\d{2})(?!\d)/.exec(name.replace(/^.*[\\/]/, ''));
  return m ? Number(m[1]) : null;
}

export interface FileMatch { file: string; number: number | null; template: string | null }

/** Map picked files to templates by number prefix; unmatched files are reported, not guessed. */
export function matchDocxFiles(names: string[], templates: Pick<CaioTemplateRow, 'number' | 'title'>[]): FileMatch[] {
  return names.map((file) => {
    const number = /\.docx$/i.test(file) ? templateNumberFromFilename(file) : null;
    const t = number === null ? undefined : templates.find((x) => x.number === number);
    return { file, number, template: t ? t.title : null };
  });
}

// ── grouping ────────────────────────────────────────────────────────────────────────────────

export const MILESTONES = ['Days 1 to 30', 'Days 31 to 60', 'Days 61 to 90', 'Months 4 to 6', 'Months 7 to 12'] as const;

export interface TemplateGroup<T> { label: string; items: T[] }

/** Group by milestone in delivery order; a template in several milestones appears in each. Others last. */
export function groupTemplatesByMilestone<T extends { number: number; milestones: string[] }>(templates: T[]): TemplateGroup<T>[] {
  const sorted = [...templates].sort((a, b) => a.number - b.number);
  const groups: TemplateGroup<T>[] = MILESTONES.map((label) => ({
    label, items: sorted.filter((t) => t.milestones.some((m) => m.trim().toLowerCase() === label.toLowerCase())),
  }));
  const other = sorted.filter((t) => !t.milestones.some((m) => MILESTONES.some((l) => l.toLowerCase() === m.trim().toLowerCase())));
  if (other.length) groups.push({ label: 'Other', items: other });
  return groups.filter((g) => g.items.length);
}

/** Detected prompts for the .docx preview. */
export function detectedPlaceholders(html: string): string[] {
  return unresolvedPlaceholders(html);
}

// ── print ───────────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PrintInfo { title: string; client: string; engagementCode: string; version: number; status: string; approver?: string | null; approvalRef?: string | null; approvedAt?: string | null; nextReview?: string | null; owner?: string | null }

/** A complete branded print page; the body goes through the sanitizer again. */
export function buildPrintHtml(info: PrintInfo, bodyHtml: string): string {
  const rows: [string, string | null | undefined][] = [
    ['Client', info.client], ['Engagement', info.engagementCode], ['Version', String(info.version)], ['Status', info.status],
    ['Owner', info.owner], ['Approver', info.approver], ['Approval reference', info.approvalRef], ['Approved', info.approvedAt?.slice(0, 10)], ['Next review', info.nextReview],
  ];
  const control = rows.filter(([, v]) => v && String(v).trim()).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(info.title)}</title><style>
@page { margin: 18mm 16mm; }
body { font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1f2b; font-size: 11pt; line-height: 1.5; }
.brand { border-bottom: 3px solid #c9a24a; padding-bottom: 8px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: baseline; }
.brand b { font-size: 12pt; letter-spacing: .04em; } .brand span { font-size: 9pt; color: #5b6475; }
h1 { font-size: 20pt; margin: 0 0 10px; } h2 { font-size: 14pt; margin: 18px 0 6px; } h3 { font-size: 12pt; margin: 14px 0 4px; } h4 { font-size: 11pt; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; page-break-inside: auto; } tr { page-break-inside: avoid; }
th, td { border: 1px solid #c8cdd8; padding: 4px 7px; text-align: left; vertical-align: top; } th { background: #eef0f5; }
.control { width: auto; margin-bottom: 18px; font-size: 9.5pt; } .control th { width: 150px; }
blockquote { border-left: 3px solid #c9a24a; margin: 8px 0; padding-left: 10px; color: #444; } code { background: #f1f2f6; padding: 0 3px; }
</style></head><body>
<div class="brand"><b>${esc(COMPANY.name.toUpperCase())}</b><span>Fractional CAIO delivery</span></div>
<h1>${esc(info.title)}</h1>
<table class="control">${control}</table>
${sanitizeDocHtml(bodyHtml)}
</body></html>`;
}
