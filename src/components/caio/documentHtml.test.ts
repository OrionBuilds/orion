import { describe, expect, it } from 'vitest';
import {
  addRowBelow, buildPrintHtml, deleteRow, editorHtml, findPlaceholderNode, groupTemplatesByMilestone, markPlaceholders, matchDocxFiles,
  rowOf, sanitizeDocHtml, templateNumberFromFilename,
} from './documentHtml';
import { unresolvedPlaceholders } from '../../services/caio';

const surface = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

describe('sanitizeDocHtml', () => {
  it('keeps the allowed structure and placeholders', () => {
    const out = sanitizeDocHtml('<h2>T</h2><table><tbody><tr><td colspan="2"><strong>[CLIENT LEGAL NAME]</strong></td></tr></tbody></table>');
    expect(out).toContain('<td colspan="2"><strong>[CLIENT LEGAL NAME]</strong></td>');
    expect(unresolvedPlaceholders(out)).toEqual(['CLIENT LEGAL NAME']);
  });
  it('strips scripts, handlers, styles, classes and data attributes', () => {
    const out = sanitizeDocHtml('<p class="x" style="color:red" onclick="a()" data-ph="">hi<script>alert(1)</script><img src=x onerror=a()></p>');
    expect(out).toBe('<p>hi</p>');
  });
  it('turns editor divs into paragraphs and forces rel on links', () => {
    const out = sanitizeDocHtml('<div>one</div><a href="https://a.test" target="_blank">l</a>');
    expect(out).toContain('<p>one</p>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('target');
  });
  it('drops javascript: links', () => {
    expect(sanitizeDocHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
  });
});

describe('display-only placeholder marks', () => {
  it('marks unresolved prompts only, and never saves the mark', () => {
    const s = surface('<p><strong>[OWNER]</strong> and <strong>bold text</strong></p>');
    expect(markPlaceholders(s)).toBe(1);
    expect(s.innerHTML).toContain('data-ph');
    const saved = editorHtml(s);
    expect(saved).not.toContain('data-ph');
    expect(saved).toBe('<p><strong>[OWNER]</strong> and <strong>bold text</strong></p>');
  });
  it('removes the mark once the prompt is replaced', () => {
    const s = surface('<p><strong data-ph="">[OWNER]</strong></p>');
    s.querySelector('strong')!.textContent = 'Jordan';
    expect(markPlaceholders(s)).toBe(0);
    expect(s.innerHTML).not.toContain('data-ph');
  });
  it('finds the nth occurrence', () => {
    const s = surface('<p><strong>[A]</strong><strong>[B]</strong><strong>[A]</strong></p>');
    expect(findPlaceholderNode(s, 'A', 1)).toBe(s.querySelectorAll('strong')[2]);
    expect(findPlaceholderNode(s, 'A', 2)).toBeNull();
  });
});

describe('table rows', () => {
  const table = '<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>';
  it('adds an empty row below the caret row', () => {
    const s = surface(table);
    addRowBelow(s.querySelector('tbody tr') as HTMLTableRowElement);
    expect(s.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(s.querySelectorAll('tbody tr')[1].children).toHaveLength(2);
    expect(s.querySelectorAll('tbody tr')[1].textContent).toBe('');
  });
  it('adds a body row at the top when the caret is in the header', () => {
    const s = surface(table);
    addRowBelow(s.querySelector('thead tr') as HTMLTableRowElement);
    expect(s.querySelectorAll('tbody tr')[0].textContent).toBe('');
    expect(s.querySelectorAll('tbody tr')).toHaveLength(2);
  });
  it('deletes a row but keeps the last one', () => {
    const s = surface(table);
    expect(deleteRow(s.querySelector('tbody tr') as HTMLTableRowElement)).toBe(true);
    expect(s.querySelectorAll('tr')).toHaveLength(1);
    expect(deleteRow(s.querySelector('tr') as HTMLTableRowElement)).toBe(false);
  });
  it('rowOf ignores carets outside a table', () => {
    const s = surface(`<p id="p">x</p>${table}`);
    expect(rowOf(s.querySelector('#p'), s)).toBeNull();
    expect(rowOf(s.querySelector('td')!.firstChild ?? s.querySelector('td'), s)).toBe(s.querySelector('tbody tr'));
  });
});

describe('docx filenames', () => {
  it('reads a two-digit prefix', () => {
    expect(templateNumberFromFilename('07 Pilot Charter.docx')).toBe(7);
    expect(templateNumberFromFilename('C:\\x\\23-release.docx')).toBe(23);
    expect(templateNumberFromFilename('7 Pilot.docx')).toBeNull();
    expect(templateNumberFromFilename('123 big.docx')).toBeNull();
    expect(templateNumberFromFilename('Pilot 07.docx')).toBeNull();
  });
  it('maps files to templates and reports the rest', () => {
    const m = matchDocxFiles(['01 Charter.docx', '99 Nope.docx', 'notes.docx', '02 Intake.pdf'], [{ number: 1, title: 'Charter' }, { number: 2, title: 'Intake' }]);
    expect(m.map((x) => x.template)).toEqual(['Charter', null, null, null]);
  });
});

describe('groupTemplatesByMilestone', () => {
  const t = (number: number, milestones: string[]) => ({ number, milestones });
  it('orders groups by delivery and repeats multi-milestone templates', () => {
    const g = groupTemplatesByMilestone([t(30, ['Months 7 to 12', 'Months 4 to 6']), t(1, ['Days 1 to 30']), t(40, []), t(21, ['Days 31 to 60', 'Days 61 to 90'])]);
    expect(g.map((x) => x.label)).toEqual(['Days 1 to 30', 'Days 31 to 60', 'Days 61 to 90', 'Months 4 to 6', 'Months 7 to 12', 'Other']);
    expect(g[3].items.map((x) => x.number)).toEqual([30]);
    expect(g[5].items.map((x) => x.number)).toEqual([40]);
  });
});

describe('buildPrintHtml', () => {
  it('escapes the header, sanitizes the body and lists document control', () => {
    const html = buildPrintHtml({ title: 'A <b>', client: 'Acme', engagementCode: 'ENG-1', version: 2, status: 'approved', approver: 'Jo', approvalRef: 'R-1' }, '<p onclick="x()">hi</p><script>1</script>');
    expect(html).toContain('A &lt;b&gt;');
    expect(html).toContain('<th>Approver</th><td>Jo</td>');
    expect(html).toContain('<p>hi</p>');
    expect(html).not.toContain('<script>1');
    expect(html).not.toContain('onclick');
  });
});

describe('editor sanitizer keeps the engine row marker', () => {
  it('keeps data-rec on table/tr in the right shape and drops it elsewhere or malformed', async () => {
    const { sanitizeEditorHtml } = await import('./documentHtml');
    const out = sanitizeEditorHtml('<table data-rec="risks/RSK-0001"><tbody><tr data-rec="risks/RSK-0001"><td data-rec="risks/RSK-0001">x</td></tr><tr data-rec="bad value!"><td>y</td></tr></tbody></table>');
    expect(out).toContain('<table data-rec="risks/RSK-0001">');
    expect(out).toContain('<tr data-rec="risks/RSK-0001">');
    expect(out).not.toContain('<td data-rec');
    expect(out).not.toContain('bad value');
  });
});
