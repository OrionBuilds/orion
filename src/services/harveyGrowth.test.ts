import { describe, expect, it } from 'vitest';
import type { HarveyProspect } from './harvey';
import {
  applyFilters, csvCell, describeFilters, facets, funnelSteps, guessMapping, importProblem, isEmptyFilters, limitTone,
  normalizeLinkedIn, parseCsv, prospectsToCsv, rowsFromCsv, safeProfileUrl, splitKnown, type ImportRow,
} from './harveyGrowth';

const p = (over: Partial<HarveyProspect> & { data?: HarveyProspect['data'] } = {}): HarveyProspect => ({
  prospect_id: 'p1', name: 'Ann Lee', title: 'CTO', company: 'Acme', email_status: 'valid', stage: 'new', score: 70,
  last_event: null, last_event_at: null, next_step_at: null, updated_at: '2026-11-01T00:00:00Z',
  ...over, data: { email: 'ann@acme.com', linkedin_url: 'https://www.linkedin.com/in/ann', source: 'scout', industry: 'Fintech', company_size: '51-200', ...over.data },
});

describe('applyFilters', () => {
  const rows = [
    p({ prospect_id: 'a' }),
    p({ prospect_id: 'b', name: 'Bo Chan', title: 'VP Engineering', company: 'Beta', stage: 'contacted', score: 40, data: { industry: 'Health', company_size: '1-10', source: 'csv', email: '', linkedin_url: '' } }),
    p({ prospect_id: 'c', name: 'Cy Diaz', title: 'Head of Data', company: 'Cora', stage: 'replied', score: 90 }),
  ];
  it('returns everyone for empty filters', () => {
    expect(isEmptyFilters({})).toBe(true);
    expect(applyFilters(rows, {})).toHaveLength(3);
  });
  it('combines stage, industry, score and contact filters', () => {
    expect(applyFilters(rows, { stages: ['contacted', 'replied'] }).map((r) => r.prospect_id)).toEqual(['b', 'c']);
    expect(applyFilters(rows, { industries: ['fintech'] }).map((r) => r.prospect_id)).toEqual(['a', 'c']);
    expect(applyFilters(rows, { minScore: 80 }).map((r) => r.prospect_id)).toEqual(['c']);
    expect(applyFilters(rows, { hasEmail: false }).map((r) => r.prospect_id)).toEqual(['b']);
    expect(applyFilters(rows, { hasLinkedIn: true }).map((r) => r.prospect_id)).toEqual(['a', 'c']);
  });
  it('matches any title word and free text', () => {
    expect(applyFilters(rows, { titles: 'cto, head of' }).map((r) => r.prospect_id)).toEqual(['a', 'c']);
    expect(applyFilters(rows, { text: 'beta' }).map((r) => r.prospect_id)).toEqual(['b']);
  });
  it('a missing score never passes a minimum score', () => {
    expect(applyFilters([p({ score: null })], { minScore: 0 })).toHaveLength(0);
  });
  it('describes and offers facets', () => {
    expect(describeFilters({})).toBe('Everyone');
    expect(describeFilters({ stages: ['new'], minScore: 50 })).toBe('stage new · score ≥ 50');
    expect(facets(rows).industries).toEqual(['Fintech', 'Health']);
  });
});

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    const t = parseCsv('﻿Name,Note\r\n"Lee, Ann","said ""hi""\nthere"\r\nBo,ok\r\n');
    expect(t).toEqual([['Name', 'Note'], ['Lee, Ann', 'said "hi"\nthere'], ['Bo', 'ok']]);
  });
  it('detects semicolon and tab delimiters and skips blank lines', () => {
    expect(parseCsv('a;b\n1;2\n\n3;4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('import mapping', () => {
  it('guesses columns from common export headers and claims each field once', () => {
    const m = guessMapping(['First Name', 'Last Name', 'Job Title', 'Company Name', 'Work Email', 'Person LinkedIn URL', 'Employees', 'Notes', 'Email']);
    expect(m).toEqual(['first_name', 'last_name', 'title', 'company', 'email', 'linkedin_url', 'company_size', null, null]);
  });
  it('builds rows, splits a full name, lowercases email and normalises LinkedIn URLs', () => {
    const table = [['Name', 'Email', 'LinkedIn', 'Company'], ['Ann Marie Lee', 'ANN@Acme.com', 'linkedin.com/in/ann/?trk=x', 'Acme']];
    const { rows, rejected } = rowsFromCsv(table, guessMapping(table[0]));
    expect(rejected).toEqual([]);
    expect(rows[0]).toMatchObject({ first_name: 'Ann Marie', last_name: 'Lee', email: 'ann@acme.com', linkedin_url: 'https://linkedin.com/in/ann', company: 'Acme' });
  });
  it('rejects rows with no name, no way to reach them, a bad email or a non-profile URL, with line numbers', () => {
    const table = [['Name', 'Email', 'LinkedIn'], ['', 'a@b.co', ''], ['Bo', '', ''], ['Cy', 'not-an-email', ''], ['Di', '', 'https://linkedin.com/company/x'], ['Ed', 'ed@x.io', '']];
    const { rows, rejected } = rowsFromCsv(table, guessMapping(table[0]));
    expect(rows.map((r) => r.first_name)).toEqual(['Ed']);
    expect(rejected).toEqual([
      { line: 2, reason: 'no name' }, { line: 3, reason: 'no email or LinkedIn URL' },
      { line: 4, reason: 'invalid email' }, { line: 5, reason: 'LinkedIn URL is not a /in/ profile' },
    ]);
  });
  it('importProblem accepts a LinkedIn-only person', () => {
    const r: ImportRow = { first_name: 'A', last_name: '', title: '', company: '', email: '', linkedin_url: 'https://linkedin.com/in/a', industry: '', company_size: '', website: '' };
    expect(importProblem(r)).toBeNull();
  });
  it('normalizeLinkedIn', () => {
    expect(normalizeLinkedIn('')).toBe('');
    expect(normalizeLinkedIn('www.linkedin.com/in/x/')).toBe('https://www.linkedin.com/in/x');
  });
  it('splits rows already in the pipeline, and repeats inside the file', () => {
    const base = { last_name: '', title: '', company: '', industry: '', company_size: '', website: '' };
    const rows: ImportRow[] = [
      { ...base, first_name: 'Ann', email: 'ann@acme.com', linkedin_url: '' },
      { ...base, first_name: 'New', email: 'new@x.io', linkedin_url: '' },
      { ...base, first_name: 'New again', email: 'new@x.io', linkedin_url: '' },
      { ...base, first_name: 'Li', email: '', linkedin_url: 'https://www.linkedin.com/in/ann' },
    ];
    const { fresh, known } = splitKnown(rows, [p()]);
    expect(fresh.map((r) => r.first_name)).toEqual(['New']);
    expect(known.map((r) => r.first_name)).toEqual(['Ann', 'New again', 'Li']);
  });
});

describe('export', () => {
  it('neutralises spreadsheet formulas and quotes awkward cells', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });
  it('writes a header and one line per prospect', () => {
    const lines = prospectsToCsv([p(), p({ prospect_id: 'x', name: '@evil' })]).trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith('Name,Title,Company,Email,LinkedIn URL')).toBe(true);
    expect(lines[2].startsWith("'@evil,")).toBe(true);
  });
});

describe('funnel and limits', () => {
  it('computes step percentages against the previous step and against contacted', () => {
    const s = funnelSteps({ prospects: 40, contacted: 20, replied: 5, interested: 2, booked: 1 });
    expect(s.map((x) => x.n)).toEqual([40, 20, 5, 2, 1]);
    expect(s[1].pctOfPrevious).toBe(50);
    expect(s[2].pctOfPrevious).toBe(25);
    expect(s[3].pctOfPrevious).toBe(40);
    expect(s[4].pctOfContacted).toBe(5);
  });
  it('never divides by zero', () => {
    const s = funnelSteps({ prospects: 0, contacted: 0, replied: 0, interested: 0, booked: 0 });
    expect(s.every((x) => x.pctOfPrevious === null)).toBe(true);
  });
  it('maps limit states to tones', () => {
    expect([limitTone('ok'), limitTone('near'), limitTone('full'), limitTone('tripped'), limitTone('?')]).toEqual(['ok', 'warn', 'bad', 'bad', 'muted']);
  });
  it('only opens https linkedin.com profile links', () => {
    expect(safeProfileUrl('https://www.linkedin.com/in/ann')).toBe('https://www.linkedin.com/in/ann');
    expect(safeProfileUrl('javascript:alert(1)')).toBeNull();
    expect(safeProfileUrl('https://evil.example/linkedin.com/in/x')).toBeNull();
    expect(safeProfileUrl('http://linkedin.com/in/x')).toBeNull();
    expect(safeProfileUrl('https://notlinkedin.com/in/x')).toBeNull();
  });
});
