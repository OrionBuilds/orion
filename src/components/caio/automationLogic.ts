/**
 * Pure helpers for the CAIO automation screens: auto-fill marks in document HTML, the approval-blocker wrapper,
 * the stale check, ranking of "Needs your input", sign-off eligibility and profile readiness. No DOM, no network.
 */
import {
  approvalBlockers, fillPlaceholder, todayIso, unresolvedPlaceholders, type CaioDocument, type CaioDocumentRow, type CaioTemplateRow,
} from '../../services/caio';
import type { CaioSubTab } from './styles';

/** Sub-tabs added by the automation work (`?caio=`). */
export type AutoSubTab = 'profile' | 'sources' | 'inbox' | 'needs' | 'signoff';
export type AnySubTab = CaioSubTab | AutoSubTab;
export type AnyNavigate = (tab: AnySubTab, opts?: { register?: string }) => void;

// ── auto-fill marks ─────────────────────────────────────────────────────────────────────────

export type MarkResolver = 'fact' | 'engagement' | 'computed' | 'register' | 'llm';
export type MarkConfidence = 'high' | 'medium' | 'low';

export interface AutoMark {
  /** data-auto: the placeholder name, `NAME#2` for later occurrences */
  id: string;
  /** the placeholder name without the `#n` suffix */
  name: string;
  resolver: MarkResolver | null;
  conf: MarkConfidence | null;
  ref: string;
  /** the visible (decoded) value */
  text: string;
}

const MARK_RE = /<mark\b([^>]*)>([\s\S]*?)<\/mark>/gi;
const ATTR_RE = /([a-z][a-z-]*)\s*=\s*"([^"]*)"/gi;
const RESOLVERS: MarkResolver[] = ['fact', 'engagement', 'computed', 'register', 'llm'];
const CONFS: MarkConfidence[] = ['high', 'medium', 'low'];

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
export const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = decode(m[2]);
  return out;
}

export const markName = (id: string) => id.replace(/#\d+$/, '');

/** Every <mark data-auto> in the body, in document order. */
export function parseMarks(html: string): AutoMark[] {
  const out: AutoMark[] = [];
  for (const m of html.matchAll(MARK_RE)) {
    const a = attrsOf(m[1]);
    if (a['data-auto'] === undefined) continue;
    const resolver = RESOLVERS.find((r) => r === a['data-resolver']) ?? null;
    const conf = CONFS.find((c) => c === a['data-conf']) ?? null;
    out.push({ id: a['data-auto'], name: markName(a['data-auto']), resolver, conf, ref: a['data-ref'] ?? '', text: decode(m[2].replace(/<[^>]*>/g, '')) });
  }
  return out;
}

export const countMarks = (html: string): number => parseMarks(html).length;

/** Replace each mark selected by `pick` with `render(mark, innerHtml)` (a string; '' keeps nothing). */
function rewriteMarks(html: string, pick: (m: AutoMark) => boolean, render: (m: AutoMark, inner: string) => string): string {
  return html.replace(MARK_RE, (whole, rawAttrs: string, inner: string) => {
    const a = attrsOf(rawAttrs);
    if (a['data-auto'] === undefined) return whole;
    const mark: AutoMark = {
      id: a['data-auto'], name: markName(a['data-auto']), resolver: RESOLVERS.find((r) => r === a['data-resolver']) ?? null,
      conf: CONFS.find((c) => c === a['data-conf']) ?? null, ref: a['data-ref'] ?? '', text: decode(inner.replace(/<[^>]*>/g, '')),
    };
    return pick(mark) ? render(mark, inner) : whole;
  });
}

/** Confirm one mark: keep its value, drop the wrapper. */
export const unwrapMark = (html: string, id: string): string => rewriteMarks(html, (m) => m.id === id, (_m, inner) => inner);

/** Confirm every mark `pick` selects (default all). */
export const unwrapMarks = (html: string, pick: (m: AutoMark) => boolean = () => true): string => rewriteMarks(html, pick, (_m, inner) => inner);

/** The owner's own wording replaces the value and the wrapper. */
export const replaceMark = (html: string, id: string, text: string): string => rewriteMarks(html, (m) => m.id === id, () => escapeText(text.trim()));

/** Plain text for print / portal: marks removed, values kept. */
export const stripMarks = (html: string): string => unwrapMarks(html);

/** Marks the "Confirm all non-AI values" button would confirm. */
export const nonAiMarks = (html: string): AutoMark[] => parseMarks(html).filter((m) => m.resolver !== 'llm');

// ── approval blockers ───────────────────────────────────────────────────────────────────────

/** `approvalBlockers` from caio.ts plus the auto-filled values that still need the owner's confirmation. */
export function approvalBlockersWithMarks(doc: Pick<CaioDocument, 'body_html' | 'approver_name' | 'approval_ref' | 'next_review'>): string[] {
  const out = approvalBlockers(doc);
  const n = countMarks(doc.body_html);
  if (n > 0) out.unshift(`${n} auto-filled value${n === 1 ? ' still needs' : 's still need'} your confirmation`);
  return out;
}

// ── stale ───────────────────────────────────────────────────────────────────────────────────

/** A draft is stale when any fact, record or source changed after it was drafted. Approved documents are never flagged. */
export function isDocumentStale(doc: Pick<CaioDocumentRow, 'status'>, generatedAt: string | null | undefined, latestInputAt: string | null | undefined): boolean {
  if (doc.status !== 'draft' && doc.status !== 'in_review') return false;
  if (!generatedAt || !latestInputAt) return false;
  const g = Date.parse(generatedAt);
  const l = Date.parse(latestInputAt);
  return Number.isFinite(g) && Number.isFinite(l) && l > g;
}

export function latestTimestamp(values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    const ms = v ? Date.parse(v) : NaN;
    if (Number.isFinite(ms) && ms > bestMs) { best = v ?? null; bestMs = ms; }
  }
  return best;
}

// ── needs your input ────────────────────────────────────────────────────────────────────────

export interface RankableRequest { id: string; kind: 'fact' | 'register'; key: string; label: string; blocks_templates: number[] }

/** Most documents blocked first; facts before registers on a tie (quicker to answer); then by label. */
export function rankInputRequests<T extends RankableRequest>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    b.blocks_templates.length - a.blocks_templates.length
    || (a.kind === b.kind ? 0 : a.kind === 'fact' ? -1 : 1)
    || a.label.localeCompare(b.label));
}

/** "05 Baseline and Opportunity Business Case" for each template number, in number order. */
export function blockedDocuments(numbers: number[], templates: Pick<CaioTemplateRow, 'number' | 'title'>[]): { number: number; title: string }[] {
  const byNumber = new Map(templates.map((t) => [t.number, t.title]));
  return [...new Set(numbers)].sort((a, b) => a - b).map((n) => ({ number: n, title: byNumber.get(n) ?? `Template ${n}` }));
}

// ── company profile ─────────────────────────────────────────────────────────────────────────

export interface ProfileFactDef { fact_key: string; profile_minimum: boolean }
export interface ProfileFact { fact_key: string; status: string }

export function profileReadiness(defs: ProfileFactDef[], facts: ProfileFact[]): { total: number; confirmed: number; missing: string[]; ready: boolean } {
  const confirmed = new Set(facts.filter((f) => f.status === 'confirmed').map((f) => f.fact_key));
  const minimum = defs.filter((d) => d.profile_minimum);
  const missing = minimum.filter((d) => !confirmed.has(d.fact_key)).map((d) => d.fact_key);
  return { total: minimum.length, confirmed: minimum.length - missing.length, missing, ready: minimum.length > 0 && missing.length === 0 };
}

export function groupBy<T>(items: T[], key: (t: T) => string): { key: string; items: T[] }[] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!map.has(k)) { map.set(k, []); order.push(k); }
    map.get(k)!.push(it);
  }
  return order.map((k) => ({ key: k, items: map.get(k)! }));
}

// ── generation jobs ─────────────────────────────────────────────────────────────────────────

export interface JobLike { status: string; last_error: string | null; created_at: string; finished_at?: string | null }

export function summarizeJobs(jobs: JobLike[]): { queued: number; running: number; failed: number; lastError: string | null } {
  const failed = jobs.filter((j) => j.status === 'failed');
  const newest = [...failed].filter((j) => j.last_error).sort((a, b) => Date.parse(b.finished_at ?? b.created_at) - Date.parse(a.finished_at ?? a.created_at))[0];
  return {
    queued: jobs.filter((j) => j.status === 'queued').length, running: jobs.filter((j) => j.status === 'running').length,
    failed: failed.length, lastError: newest?.last_error ?? null,
  };
}

// ── sign-off queue ──────────────────────────────────────────────────────────────────────────

/**
 * Placeholders (all resolver 'human') that are the approval or decision record of THIS document: who approved it, the
 * reference, the dates, the decision, its conditions and sign-off notes. The owner types each value once per batch.
 * Evidence links, test results, measured outcomes, due dates of other items and anyone else's name stay per document.
 */
export type SignOffKey = 'approver' | 'ref' | 'date' | 'nextReview' | 'status' | 'decision' | 'conditions' | 'decisionMaker' | 'note' | 'scope';
const SIGN_OFF_FIELD: Record<string, SignOffKey> = {
  APPROVER: 'approver', 'APPROVED BY': 'approver', 'ACCEPTED BY': 'approver', 'APPROVAL REFERENCE': 'ref',
  'APPROVAL DATE': 'date', 'ACCEPTANCE DATE': 'date', 'NEXT REVIEW': 'nextReview', 'APPROVAL STATUS': 'status',
  'DECISION MADE': 'decision', CONDITIONS: 'conditions', 'DECISION MAKER': 'decisionMaker',
  'ACCEPTANCE NOTE': 'note', 'SIGN-OFF NOTE': 'note', 'SCOPE OF SIGN-OFF': 'scope',
};
export const isAttestationName = (name: string) => name in SIGN_OFF_FIELD;

/** Which batch inputs the given placeholder names call for (approver, reference and next review are always asked). */
export function signOffNeeds(names: string[]): SignOffKey[] {
  const set = new Set<SignOffKey>(['approver', 'ref', 'nextReview']);
  for (const n of names) { const k = SIGN_OFF_FIELD[n]; if (k) set.add(k); }
  return [...set];
}

export const SIGN_OFF_LABEL: Record<SignOffKey, string> = {
  approver: 'Approver', ref: 'Approval reference', date: 'Approval date', nextReview: 'Next review date', status: 'Status',
  decision: 'Decision made', conditions: 'Conditions (write "None" if there are none)', decisionMaker: 'Decision maker', note: 'Sign-off note', scope: 'Scope of sign-off',
};

export interface SignOffCheck { eligible: boolean; attestations: string[]; reason: string | null }

/** Eligible: draft or in review, no unconfirmed marks, and every remaining placeholder is a human approval/decision field. */
export function signOffCheck(doc: Pick<CaioDocument, 'status' | 'body_html'>, resolvers: Record<string, string>): SignOffCheck {
  const remaining = unresolvedPlaceholders(doc.body_html);
  if (doc.status !== 'draft' && doc.status !== 'in_review') return { eligible: false, attestations: [], reason: 'Not a draft' };
  const marks = countMarks(doc.body_html);
  if (marks > 0) return { eligible: false, attestations: remaining, reason: `${marks} auto-filled value${marks === 1 ? '' : 's'} to confirm first` };
  const other = remaining.filter((n) => !(isAttestationName(n) && resolvers[n] === 'human'));
  if (other.length) return { eligible: false, attestations: [], reason: `${other.length} other placeholder${other.length === 1 ? '' : 's'} to fill (first: ${other[0]})` };
  return { eligible: true, attestations: remaining, reason: null };
}

export interface SignOffInput {
  approver: string; ref: string; nextReview: string; date?: string;
  decision?: string; conditions?: string; decisionMaker?: string; note?: string; scope?: string;
}

/** Fill the approval/decision placeholders present in the body. Nothing is invented: the caller supplies every value. */
export function applySignOff(html: string, input: SignOffInput): string {
  const value: Record<SignOffKey, string> = {
    approver: input.approver.trim(), ref: input.ref.trim(), date: input.date ?? todayIso(), nextReview: input.nextReview, status: 'Approved',
    decision: (input.decision ?? '').trim(), conditions: (input.conditions ?? '').trim(),
    decisionMaker: (input.decisionMaker ?? '').trim() || input.approver.trim(), note: (input.note ?? '').trim(), scope: (input.scope ?? '').trim(),
  };
  let out = html;
  for (const name of unresolvedPlaceholders(html)) {
    const field = SIGN_OFF_FIELD[name];
    if (field && value[field]) out = fillPlaceholder(out, name, value[field]);
  }
  return out;
}

/** What the owner still has to type before the batch can run. `needs` comes from signOffNeeds over the chosen documents. */
export function signOffInputBlockers(input: SignOffInput, needs: SignOffKey[] = ['approver', 'ref', 'nextReview']): string[] {
  const out: string[] = [];
  const has = (k: SignOffKey) => needs.includes(k);
  if (!input.approver.trim()) out.push('approver');
  if (!input.ref.trim()) out.push('approval reference');
  if (!input.nextReview) out.push('next review date');
  if (has('decision') && !(input.decision ?? '').trim()) out.push('decision made');
  if (has('conditions') && !(input.conditions ?? '').trim()) out.push('conditions');
  if (has('note') && !(input.note ?? '').trim()) out.push('sign-off note');
  if (has('scope') && !(input.scope ?? '').trim()) out.push('scope of sign-off');
  return out;
}

// ── source upload ───────────────────────────────────────────────────────────────────────────

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;

/** Files the ingest function would accept; the rest are listed with a reason. */
export function checkFiles(files: File[]): { ok: File[]; rejected: { name: string; reason: string }[] } {
  const ok: File[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const f of files) {
    if (!/\.(docx|pdf|txt|md|vtt)$/i.test(f.name)) rejected.push({ name: f.name, reason: 'Unsupported type (use .docx .pdf .txt .md .vtt)' });
    else if (f.size > MAX_BYTES) rejected.push({ name: f.name, reason: 'Larger than 25 MB' });
    else if (f.size === 0) rejected.push({ name: f.name, reason: 'Empty file' });
    else if (ok.length >= MAX_FILES) rejected.push({ name: f.name, reason: `Only ${MAX_FILES} files at a time` });
    else ok.push(f);
  }
  return { ok, rejected };
}

// ── inbox ───────────────────────────────────────────────────────────────────────────────────

export interface BulkCandidate { confidence: string; flags: string[]; status: string }

/** "Accept all high-confidence": high confidence only, never a legal candidate or unverified public research. */
export function isBulkAcceptable(p: BulkCandidate): boolean {
  return p.status === 'proposed' && p.confidence === 'high' && !p.flags.includes('legal_candidate') && !p.flags.includes('public_research');
}

export const FLAG_LABEL: Record<string, string> = {
  legal_candidate: 'for a qualified reviewer to verify', public_research: 'from public web, unverified', contains_npi: 'may contain personal information',
};
