import { describe, expect, it } from 'vitest';
import {
  applySignOff, approvalBlockersWithMarks, blockedDocuments, checkFiles, countMarks, groupBy, isBulkAcceptable, isDocumentStale, latestTimestamp,
  nonAiMarks, parseMarks, profileReadiness, rankInputRequests, replaceMark, signOffCheck, signOffInputBlockers, signOffNeeds, stripMarks, summarizeJobs, unwrapMark, unwrapMarks,
} from './automationLogic';
import { sanitizeDocHtml, sanitizeEditorHtml } from './documentHtml';

const mark = (id: string, resolver: string, text: string, conf = 'high', ref = 'fact:industry') =>
  `<mark data-auto="${id}" data-resolver="${resolver}" data-conf="${conf}" data-ref="${ref}">${text}</mark>`;
const body = `<p>Industry ${mark('INDUSTRY', 'fact', 'Roofing &amp; repair')} and ${mark('INDUSTRY#2', 'fact', 'Roofing')} then ${mark('RISK SUMMARY', 'llm', 'Low', 'low', 'source:abc')}.</p>`;

describe('marks', () => {
  it('parses ids, resolver, confidence, ref and decoded text in order', () => {
    const m = parseMarks(body);
    expect(m.map((x) => x.id)).toEqual(['INDUSTRY', 'INDUSTRY#2', 'RISK SUMMARY']);
    expect(m[0]).toMatchObject({ name: 'INDUSTRY', resolver: 'fact', conf: 'high', ref: 'fact:industry', text: 'Roofing & repair' });
    expect(m[1].name).toBe('INDUSTRY');
    expect(m[2]).toMatchObject({ resolver: 'llm', conf: 'low' });
    expect(countMarks('<p>none</p><mark>plain</mark>')).toBe(0);
  });
  it('confirm unwraps one mark and keeps its (escaped) value', () => {
    const out = unwrapMark(body, 'INDUSTRY');
    expect(out).toContain('Industry Roofing &amp; repair and');
    expect(parseMarks(out).map((x) => x.id)).toEqual(['INDUSTRY#2', 'RISK SUMMARY']);
  });
  it('edit replaces the mark with the owner text, escaped', () => {
    const out = replaceMark(body, 'RISK SUMMARY', ' High <b>risk</b> ');
    expect(out).toContain('then High &lt;b&gt;risk&lt;/b&gt;.');
    expect(countMarks(out)).toBe(2);
  });
  it('confirm all non-AI leaves model-drafted values marked', () => {
    expect(nonAiMarks(body)).toHaveLength(2);
    const out = unwrapMarks(body, (m) => m.resolver !== 'llm');
    expect(parseMarks(out).map((x) => x.id)).toEqual(['RISK SUMMARY']);
    expect(countMarks(stripMarks(body))).toBe(0);
  });
});

describe('approval blockers', () => {
  const doc = { body_html: body, approver_name: 'Pat', approval_ref: 'MIN-1', next_review: '2027-01-01' };
  it('adds the unconfirmed-values message first', () => {
    expect(approvalBlockersWithMarks(doc)).toEqual(['3 auto-filled values still need your confirmation']);
    expect(approvalBlockersWithMarks({ ...doc, body_html: mark('A', 'fact', 'x') })).toEqual(['1 auto-filled value still needs your confirmation']);
  });
  it('keeps the base blockers and is empty when confirmed', () => {
    expect(approvalBlockersWithMarks({ ...doc, approver_name: '' })).toContain('approver');
    expect(approvalBlockersWithMarks({ ...doc, body_html: '<p>done</p>' })).toEqual([]);
  });
});

describe('sanitizing marks', () => {
  it('editor path keeps mark with only the four data attributes', () => {
    const out = sanitizeEditorHtml(`<p>${mark('X', 'fact', 'v')}<span data-auto="no" data-x="1">s</span><mark onclick="a()" data-auto="Y" data-resolver="evil" style="c:red">w</mark><mark data-ref="z">bare</mark></p>`);
    expect(out).toContain('<mark data-auto="X" data-resolver="fact" data-conf="high" data-ref="fact:industry">v</mark>');
    expect(out).toContain('<span>s</span>');
    expect(out).toContain('<mark data-auto="Y">w</mark>');
    expect(out).toContain('bare');
    expect(out).not.toMatch(/onclick|style|data-x|evil|data-ref="z"/);
  });
  it('print and portal path turns marks into plain text', () => {
    const out = sanitizeDocHtml(body);
    expect(out).not.toContain('<mark');
    expect(out).not.toContain('data-');
    expect(out).toContain('Roofing &amp; repair');
  });
});

describe('stale', () => {
  it('flags drafts when an input changed after generation', () => {
    expect(isDocumentStale({ status: 'draft' }, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')).toBe(true);
    expect(isDocumentStale({ status: 'draft' }, '2026-11-03T00:00:00Z', '2026-11-02T00:00:00Z')).toBe(false);
    expect(isDocumentStale({ status: 'approved' }, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')).toBe(false);
    expect(isDocumentStale({ status: 'draft' }, null, '2026-11-02T00:00:00Z')).toBe(false);
    expect(latestTimestamp([null, '2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z', undefined])).toBe('2026-11-05T00:00:00Z');
  });
});

describe('needs your input', () => {
  const r = (id: string, kind: 'fact' | 'register', label: string, n: number[]) => ({ id, kind, key: id, label, blocks_templates: n });
  it('ranks by documents blocked, then facts before registers, then label', () => {
    const out = rankInputRequests([r('a', 'register', 'Vendors', [1, 2]), r('b', 'fact', 'Zeta', [1]), r('c', 'fact', 'Alpha', [1]), r('d', 'fact', 'Staff', [1, 2, 3]), r('e', 'fact', 'Beta', [1, 2])]);
    expect(out.map((x) => x.id)).toEqual(['d', 'e', 'a', 'c', 'b']);
  });
  it('names the blocked documents in number order', () => {
    expect(blockedDocuments([5, 2, 5, 99], [{ number: 2, title: 'Assessment' }, { number: 5, title: 'Business Case' }])).toEqual([
      { number: 2, title: 'Assessment' }, { number: 5, title: 'Business Case' }, { number: 99, title: 'Template 99' },
    ]);
  });
});

describe('profile readiness and grouping', () => {
  const defs = [{ fact_key: 'a', profile_minimum: true }, { fact_key: 'b', profile_minimum: true }, { fact_key: 'c', profile_minimum: false }];
  it('counts only confirmed minimum facts', () => {
    expect(profileReadiness(defs, [{ fact_key: 'a', status: 'confirmed' }, { fact_key: 'b', status: 'proposed' }, { fact_key: 'c', status: 'confirmed' }]))
      .toEqual({ total: 2, confirmed: 1, missing: ['b'], ready: false });
    expect(profileReadiness(defs, [{ fact_key: 'a', status: 'confirmed' }, { fact_key: 'b', status: 'confirmed' }]).ready).toBe(true);
    expect(profileReadiness([], []).ready).toBe(false);
  });
  it('groups in first-seen order', () => {
    expect(groupBy([{ g: 'x', v: 1 }, { g: 'y', v: 2 }, { g: 'x', v: 3 }], (i) => i.g).map((g) => [g.key, g.items.length])).toEqual([['x', 2], ['y', 1]]);
  });
});

describe('jobs', () => {
  it('counts states and reports the newest failure', () => {
    const s = summarizeJobs([
      { status: 'queued', last_error: null, created_at: '2026-11-01T00:00:00Z' }, { status: 'running', last_error: null, created_at: '2026-11-01T00:00:00Z' },
      { status: 'failed', last_error: 'old', created_at: '2026-11-01T00:00:00Z', finished_at: '2026-11-01T01:00:00Z' },
      { status: 'failed', last_error: 'new', created_at: '2026-11-02T00:00:00Z', finished_at: '2026-11-02T01:00:00Z' },
    ]);
    expect(s).toEqual({ queued: 1, running: 1, failed: 2, lastError: 'new' });
    expect(summarizeJobs([]).lastError).toBeNull();
  });
});

describe('sign-off', () => {
  const human = { APPROVER: 'human', 'APPROVAL REFERENCE': 'human', 'NEXT REVIEW': 'human', 'APPROVAL DATE': 'human', FINDING: 'human', NAME: 'llm' };
  const ph = (n: string) => `<strong>[${n}]</strong>`;
  it('is eligible only when every remaining placeholder is an approval field and no marks remain', () => {
    const ok = signOffCheck({ status: 'draft', body_html: `<p>${ph('APPROVER')} ${ph('APPROVAL REFERENCE')} ${ph('NEXT REVIEW')}</p>` }, human);
    expect(ok).toEqual({ eligible: true, attestations: ['APPROVER', 'APPROVAL REFERENCE', 'NEXT REVIEW'], reason: null });
    expect(signOffCheck({ status: 'draft', body_html: `${ph('APPROVER')}${ph('FINDING')}` }, human).eligible).toBe(false);
    expect(signOffCheck({ status: 'draft', body_html: `${ph('APPROVER')}${mark('A', 'fact', 'x')}` }, human).reason).toMatch(/confirm first/);
    expect(signOffCheck({ status: 'approved', body_html: ph('APPROVER') }, human).eligible).toBe(false);
    // an approval name the owner reclassified away from human is not an attestation
    expect(signOffCheck({ status: 'draft', body_html: ph('APPROVER') }, { APPROVER: 'llm' }).eligible).toBe(false);
  });
  it('fills only what the owner typed, never inventing a reference', () => {
    const html = `<p>${ph('APPROVER')} ${ph('APPROVAL REFERENCE')} ${ph('APPROVAL DATE')} ${ph('NEXT REVIEW')} ${ph('FINDING')}</p>`;
    const out = applySignOff(html, { approver: 'Pat Lee', ref: 'MIN-4', nextReview: '2027-02-01', date: '2026-11-05' });
    expect(out).toBe(`<p>Pat Lee MIN-4 2026-11-05 2027-02-01 ${ph('FINDING')}</p>`);
    expect(applySignOff(html, { approver: 'Pat', ref: '', nextReview: '' })).toContain(ph('APPROVAL REFERENCE'));
    expect(signOffInputBlockers({ approver: '', ref: ' ', nextReview: '' })).toEqual(['approver', 'approval reference', 'next review date']);
  });
});

describe('inbox and upload checks', () => {
  it('bulk accept skips legal candidates, public research and non-high confidence', () => {
    const p = (confidence: string, flags: string[] = []) => ({ confidence, flags, status: 'proposed' });
    expect(isBulkAcceptable(p('high'))).toBe(true);
    expect(isBulkAcceptable(p('medium'))).toBe(false);
    expect(isBulkAcceptable(p('high', ['legal_candidate']))).toBe(false);
    expect(isBulkAcceptable(p('high', ['public_research']))).toBe(false);
  });
  it('accepts supported types within limits and explains the rest', () => {
    const f = (name: string, size = 10) => new File([new Uint8Array(size)], name);
    const r = checkFiles([f('a.docx'), f('b.exe'), f('c.pdf', 26 * 1024 * 1024), f('d.txt', 0), f('e.VTT')]);
    expect(r.ok.map((x) => x.name)).toEqual(['a.docx', 'e.VTT']);
    expect(r.rejected.map((x) => x.name)).toEqual(['b.exe', 'c.pdf', 'd.txt']);
    const many = checkFiles(Array.from({ length: 12 }, (_, i) => f(`f${i}.md`)));
    expect(many.ok).toHaveLength(10);
    expect(many.rejected).toHaveLength(2);
  });
});

describe('sign-off: decision fields', () => {
  const human = { APPROVER: 'human', 'DECISION MADE': 'human', CONDITIONS: 'human', 'DECISION MAKER': 'human', 'EVIDENCE ID OR LINK': 'human', 'NEXT REVIEW': 'human' };
  const ph = (n: string) => `<strong>[${n}]</strong>`;
  it('treats the decision block as sign-off, but never evidence links or other items', () => {
    expect(signOffCheck({ status: 'draft', body_html: `${ph('APPROVER')}${ph('DECISION MADE')}${ph('CONDITIONS')}${ph('DECISION MAKER')}` }, human).eligible).toBe(true);
    expect(signOffCheck({ status: 'draft', body_html: `${ph('APPROVER')}${ph('EVIDENCE ID OR LINK')}` }, human).eligible).toBe(false);
  });
  it('asks only for the inputs the chosen documents need', () => {
    expect(signOffNeeds(['APPROVER']).sort()).toEqual(['approver', 'nextReview', 'ref']);
    expect(signOffNeeds(['DECISION MADE', 'CONDITIONS'])).toEqual(expect.arrayContaining(['decision', 'conditions']));
  });
  it('requires typed decision and conditions, and fills them; decision maker defaults to the approver', () => {
    const needs = signOffNeeds(['DECISION MADE', 'CONDITIONS', 'DECISION MAKER']);
    expect(signOffInputBlockers({ approver: 'Pat', ref: 'R1', nextReview: '2027-01-01' }, needs)).toEqual(['decision made', 'conditions']);
    const html = applySignOff(`${ph('DECISION MADE')} | ${ph('CONDITIONS')} | ${ph('DECISION MAKER')} | ${ph('EVIDENCE ID OR LINK')}`,
      { approver: 'Pat Lee', ref: 'R1', nextReview: '2027-01-01', decision: 'Approved for pilot', conditions: 'None' });
    expect(html).toContain('Approved for pilot | None | Pat Lee');
    expect(html).toContain('[EVIDENCE ID OR LINK]');
  });
});
