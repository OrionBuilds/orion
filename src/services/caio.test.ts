import { describe, expect, it } from 'vitest';
import {
  approvalBlockers, cleanData, csvEscape, daysUntil, dueTone, fillPlaceholder, gateAcceptBlockers, gateProgress, gateTone, isPlaceholderValue, mapCsv,
  parseCsv, placeholderCount, prefillTemplate, recordsToCsv, unresolvedPlaceholders, type Gate, type RegisterDef,
} from './caio';

const NOW = new Date(2026, 10, 4, 12); // 4 Nov 2026 local

const html = '<p>Client <strong>[CLIENT LEGAL NAME]</strong> owns <strong>[SYSTEM ID]</strong>; again <strong>[CLIENT LEGAL NAME]</strong>.</p><p><b>[ DATE ]</b> <strong>Not a placeholder</strong> <strong>[lower case]</strong></p>';

describe('placeholders', () => {
  it('lists distinct bold upper-case prompts only, in first-appearance order', () => {
    expect(unresolvedPlaceholders(html)).toEqual(['CLIENT LEGAL NAME', 'SYSTEM ID']);
    expect(placeholderCount(html, 'CLIENT LEGAL NAME')).toBe(2);
  });
  it('fills every occurrence of one placeholder and escapes the value', () => {
    const out = fillPlaceholder(html, 'CLIENT LEGAL NAME', 'Acme <Roofing> & Co');
    expect(out).not.toContain('[CLIENT LEGAL NAME]');
    expect(out.match(/Acme &lt;Roofing&gt; &amp; Co/g)).toHaveLength(2);
    expect(unresolvedPlaceholders(out)).toEqual(['SYSTEM ID']);
  });
  it('prefill ignores blank values', () => {
    expect(unresolvedPlaceholders(prefillTemplate(html, { 'CLIENT LEGAL NAME': 'Acme', 'SYSTEM ID': '  ' }))).toEqual(['SYSTEM ID']);
  });
  it('recognises an untouched workbook-style value', () => {
    expect(isPlaceholderValue('[SYSTEM NAME]')).toBe(true);
    expect(isPlaceholderValue('N/A: not used')).toBe(false);
  });
});

describe('approval and gates', () => {
  const doc = { body_html: html, approver_name: '', approval_ref: null, next_review: null };
  it('lists everything blocking approval', () => {
    expect(approvalBlockers(doc)).toEqual(['2 placeholders still to fill (first: CLIENT LEGAL NAME)', 'approver', 'approval reference', 'next review date']);
    expect(approvalBlockers({ body_html: '<p>done</p>', approver_name: 'Pat', approval_ref: 'MIN-1', next_review: '2027-01-01' })).toEqual([]);
  });
  const gate = (met: boolean[], over: Partial<Gate> = {}): Gate => ({
    id: 'g', engagement_id: 'e', gate_key: 'day_30', due_date: '2026-11-10', status: 'open', decided_by: null, decided_at: null, decision_note: null,
    conditions: met.map((m, i) => ({ text: `c${i}`, met: m, evidence_link: '', note: '' })), ...over,
  });
  it('counts met conditions and demands a written decision for unmet ones', () => {
    expect(gateProgress(gate([true, false, true]))).toEqual({ met: 2, total: 3 });
    expect(gateAcceptBlockers(gate([true, false]))).toEqual(['who is deciding', 'a written decision for the 1 unmet condition']);
    expect(gateAcceptBlockers(gate([true, true], { decided_by: 'Pat' }))).toEqual([]);
    expect(gateAcceptBlockers(gate([false, false], { decided_by: 'Pat', decision_note: 'Waived' }))).toEqual([]);
  });
  it('tones follow status then date', () => {
    expect(gateTone(gate([], { status: 'accepted' }), NOW)).toBe('good');
    expect(gateTone(gate([], { status: 'remediation' }), NOW)).toBe('warn');
    expect(gateTone(gate([], { due_date: '2026-11-02' }), NOW)).toBe('bad');
    expect(gateTone(gate([], { due_date: '2026-11-10' }), NOW)).toBe('warn');
    expect(gateTone(gate([], { due_date: '2027-02-01' }), NOW)).toBe('good');
  });
});

describe('dates', () => {
  it('counts whole days, negative when overdue', () => {
    expect(daysUntil('2026-11-04', NOW)).toBe(0);
    expect(daysUntil('2026-11-01', NOW)).toBe(-3);
    expect(daysUntil('2026-12-04', NOW)).toBe(30);
    expect(daysUntil(null, NOW)).toBeNull();
    expect(dueTone(null, NOW)).toBe('muted');
  });
});

const DEF: RegisterDef = {
  register_key: 'risks', title: 'Risks', prefix: 'RSK', purpose: '', sort: 3,
  fields: [
    { register_key: 'risks', field_key: 'risk_id', label: 'Risk ID', ftype: 'text', sort: 1, options: null, promote_as: null, is_id: true, is_due: false, client_safe: true },
    { register_key: 'risks', field_key: 'system_id', label: 'System ID', ftype: 'text', sort: 2, options: null, promote_as: 'system_ref', is_id: false, is_due: false, client_safe: true },
    { register_key: 'risks', field_key: 'failure_scenario', label: 'Failure scenario', ftype: 'longtext', sort: 3, options: null, promote_as: null, is_id: false, is_due: false, client_safe: true },
    { register_key: 'risks', field_key: 'status', label: 'Status', ftype: 'select', sort: 4, options: ['Open', 'Closed'], promote_as: 'status', is_id: false, is_due: false, client_safe: true },
  ],
};

describe('csv', () => {
  it('parses quotes, doubled quotes, embedded newlines and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nbye"\r\n,\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"\nbye']]);
    expect(csvEscape('a,b "c"')).toBe('"a,b ""c"""');
  });
  it('round-trips records through export and import', () => {
    const csv = recordsToCsv(DEF, [{ data: { risk_id: 'RSK-0001', system_id: 'SYS-0001', failure_scenario: 'Wrong, answer\nsent', status: 'Open' } }]);
    const m = mapCsv(DEF, csv);
    expect(m.rows).toEqual([{ risk_id: 'RSK-0001', system_id: 'SYS-0001', failure_scenario: 'Wrong, answer\nsent', status: 'Open' }]);
    expect(m.ignored).toEqual([]);
  });
  it('maps headers loosely, finds the header row under title rows, skips workbook placeholder rows', () => {
    const csv = ['Risks,,,', 'Record a concrete failure scenario,,,', 'RISK ID,system id,Failure Scenario,Status,Extra col',
      '[REPLACE PLACEHOLDER BELOW],[REPLACE PLACEHOLDER BELOW],[REPLACE PLACEHOLDER BELOW],[REPLACE PLACEHOLDER BELOW],',
      '[RISK ID],[SYSTEM ID],[FAILURE SCENARIO],[STATUS],', 'RSK-1,SYS-1,Leaks data,Open,x', ',,,,'].join('\n');
    const m = mapCsv(DEF, csv);
    expect(m.rows).toEqual([{ risk_id: 'RSK-1', system_id: 'SYS-1', failure_scenario: 'Leaks data', status: 'Open' }]);
    expect(m.skipped).toBe(2);
    expect(m.ignored).toEqual(['Extra col']);
  });
  it('cleanData drops blanks and trims', () => {
    expect(cleanData({ a: ' x ', b: '', c: null, d: 4, e: '   ' })).toEqual({ a: 'x', d: 4 });
  });
});
