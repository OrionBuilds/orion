/**
 * Harvey growth tools: saved prospect searches, CSV import / export, the outreach funnel and the
 * LinkedIn "I sent it" hand-off (migration 20261111100000_harvey_growth.sql).
 *
 * Harvey owns his prospects; the OS holds a mirror (harvey_prospects). So filtering and export run
 * here over the mirror, while an import is only QUEUED as a command: Harvey dedupes, checks his
 * suppression lists and still verifies every address before anything is sent. The pure helpers are
 * unit-tested in harveyGrowth.test.ts.
 */
import { supabase } from '../lib/supabase';
import { sendCommand, type HarveyProspect } from './harvey';

const MIGRATION_HINT = 'The HARVEY growth tools are not available yet: migration 20261111100000_harvey_growth.sql has not been applied to this database.';

function fail(error: { message?: string; code?: string } | null): Error {
  const msg = error?.message ?? 'Request failed';
  if (error?.code === 'PGRST205' || error?.code === 'PGRST202' || error?.code === '42P01' || error?.code === '42883'
    || /could not find the (table|function)|does not exist/i.test(msg)) return new Error(MIGRATION_HINT);
  return new Error(msg);
}

// ── saved searches ───────────────────────────────────────────────────────────────────────────

export interface ProspectFilters {
  text?: string;
  stages?: string[];
  industries?: string[];
  sources?: string[];
  companySizes?: string[];
  /** Comma or newline separated words; a prospect matches when its title contains any of them. */
  titles?: string;
  minScore?: number | null;
  hasEmail?: boolean | null;
  hasLinkedIn?: boolean | null;
}

export interface HarveySearch {
  id: string;
  name: string;
  filters: ProspectFilters;
  created_at: string;
  updated_at: string;
}

export async function listSearches(orgId: string): Promise<HarveySearch[]> {
  const { data, error } = await supabase
    .from('harvey_searches')
    .select('id,name,filters,created_at,updated_at')
    .eq('org_id', orgId)
    .order('name', { ascending: true });
  if (error) throw fail(error);
  return (data ?? []) as HarveySearch[];
}

export async function saveSearch(orgId: string, userId: string, name: string, filters: ProspectFilters, id?: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error('Give the search a name.');
  const { error } = id
    ? await supabase.from('harvey_searches').update({ name: clean, filters, updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId)
    : await supabase.from('harvey_searches').insert({ org_id: orgId, name: clean, filters, created_by: userId });
  if (error) {
    if (error.code === '23505') throw new Error(`A search named "${clean}" already exists.`);
    throw fail(error);
  }
}

export async function deleteSearch(orgId: string, id: string): Promise<void> {
  const { error } = await supabase.from('harvey_searches').delete().eq('id', id).eq('org_id', orgId);
  if (error) throw fail(error);
}

export const emptyFilters = (): ProspectFilters => ({});

export function isEmptyFilters(f: ProspectFilters): boolean {
  return !f.text?.trim() && !f.titles?.trim() && !f.stages?.length && !f.industries?.length && !f.sources?.length
    && !f.companySizes?.length && (f.minScore == null) && f.hasEmail == null && f.hasLinkedIn == null;
}

const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();

export function applyFilters(rows: HarveyProspect[], f: ProspectFilters): HarveyProspect[] {
  const text = lc(f.text);
  const titleWords = (f.titles ?? '').split(/[,\n]/).map(lc).filter(Boolean);
  const stages = new Set(f.stages ?? []);
  const industries = new Set((f.industries ?? []).map(lc));
  const sources = new Set((f.sources ?? []).map(lc));
  const sizes = new Set((f.companySizes ?? []).map(lc));
  return rows.filter((p) => {
    if (stages.size && !stages.has(p.stage)) return false;
    if (industries.size && !industries.has(lc(p.data.industry))) return false;
    if (sources.size && !sources.has(lc(p.data.source))) return false;
    if (sizes.size && !sizes.has(lc(p.data.company_size))) return false;
    if (f.minScore != null && (p.score == null || !(Number(p.score) >= f.minScore))) return false;
    if (f.hasEmail != null && Boolean(p.data.email) !== f.hasEmail) return false;
    if (f.hasLinkedIn != null && Boolean(p.data.linkedin_url) !== f.hasLinkedIn) return false;
    if (titleWords.length && !titleWords.some((w) => lc(p.title).includes(w))) return false;
    if (text && !`${p.name} ${p.company} ${p.title} ${p.data.email ?? ''}`.toLowerCase().includes(text)) return false;
    return true;
  });
}

export function describeFilters(f: ProspectFilters): string {
  const parts: string[] = [];
  if (f.stages?.length) parts.push(`stage ${f.stages.join('/')}`);
  if (f.titles?.trim()) parts.push(`title ${f.titles.trim().replace(/\s*\n\s*/g, ', ')}`);
  if (f.industries?.length) parts.push(`industry ${f.industries.join('/')}`);
  if (f.companySizes?.length) parts.push(`size ${f.companySizes.join('/')}`);
  if (f.sources?.length) parts.push(`source ${f.sources.join('/')}`);
  if (f.minScore != null) parts.push(`score ≥ ${f.minScore}`);
  if (f.hasEmail != null) parts.push(f.hasEmail ? 'has email' : 'no email');
  if (f.hasLinkedIn != null) parts.push(f.hasLinkedIn ? 'has LinkedIn' : 'no LinkedIn');
  if (f.text?.trim()) parts.push(`"${f.text.trim()}"`);
  return parts.join(' · ') || 'Everyone';
}

/** The distinct values worth offering as filter choices. */
export function facets(rows: HarveyProspect[]): { stages: string[]; industries: string[]; sources: string[]; sizes: string[] } {
  const uniq = (xs: Array<string | undefined | null>) => [...new Set(xs.map((x) => (x ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    stages: uniq(rows.map((r) => r.stage)),
    industries: uniq(rows.map((r) => r.data.industry)),
    sources: uniq(rows.map((r) => r.data.source)),
    sizes: uniq(rows.map((r) => r.data.company_size)),
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────

/** RFC 4180-style parser: quoted fields, doubled quotes, CRLF, and a comma / semicolon / tab delimiter. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export const IMPORT_FIELDS = ['first_name', 'last_name', 'name', 'title', 'company', 'email', 'linkedin_url', 'industry', 'company_size', 'website'] as const;
export type ImportField = typeof IMPORT_FIELDS[number];

export const IMPORT_FIELD_LABEL: Record<ImportField, string> = {
  first_name: 'First name', last_name: 'Last name', name: 'Full name', title: 'Title', company: 'Company', email: 'Email',
  linkedin_url: 'LinkedIn URL', industry: 'Industry', company_size: 'Company size', website: 'Website',
};

const ALIASES: Record<ImportField, string[]> = {
  first_name: ['first name', 'firstname', 'first', 'given name'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name'],
  name: ['name', 'full name', 'fullname', 'contact', 'contact name'],
  title: ['title', 'job title', 'position', 'role', 'headline'],
  company: ['company', 'company name', 'organization', 'organisation', 'employer', 'account'],
  email: ['email', 'e-mail', 'email address', 'work email', 'business email'],
  linkedin_url: ['linkedin', 'linkedin url', 'linkedin profile', 'linkedin profile url', 'profile url', 'person linkedin url', 'li url'],
  industry: ['industry', 'sector', 'vertical'],
  company_size: ['company size', 'size', 'employees', 'headcount', '# employees', 'employee count', 'number of employees'],
  website: ['website', 'company website', 'domain', 'company domain', 'url', 'site'],
};

/** For each header, the field it most likely holds (null = ignore). A field is claimed by the first header that matches it. */
export function guessMapping(header: string[]): Array<ImportField | null> {
  const taken = new Set<ImportField>();
  return header.map((h) => {
    const key = h.trim().toLowerCase();
    const hit = IMPORT_FIELDS.find((f) => !taken.has(f) && ALIASES[f].includes(key));
    if (hit) taken.add(hit);
    return hit ?? null;
  });
}

export interface ImportRow {
  first_name: string; last_name: string; title: string; company: string; email: string;
  linkedin_url: string; industry: string; company_size: string; website: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINKEDIN_RE = /linkedin\.com\/in\//i;

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? '', last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

export function normalizeLinkedIn(url: string): string {
  const t = url.trim();
  if (!t) return '';
  const withProto = /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/\//, '')}`;
  return withProto.replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** Why a row can't be imported, or null. Needs a name and a way to reach them. */
export function importProblem(r: ImportRow): string | null {
  if (!r.first_name && !r.last_name) return 'no name';
  if (!r.email && !r.linkedin_url) return 'no email or LinkedIn URL';
  if (r.email && !EMAIL_RE.test(r.email)) return 'invalid email';
  if (!r.email && !LINKEDIN_RE.test(r.linkedin_url)) return 'LinkedIn URL is not a /in/ profile';
  return null;
}

export function rowsFromCsv(table: string[][], mapping: Array<ImportField | null>): { rows: ImportRow[]; rejected: Array<{ line: number; reason: string }> } {
  const rows: ImportRow[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  table.slice(1).forEach((cells, i) => {
    const pick: Partial<Record<ImportField, string>> = {};
    mapping.forEach((field, col) => { if (field && !pick[field]) pick[field] = (cells[col] ?? '').trim(); });
    let first = pick.first_name ?? '';
    let last = pick.last_name ?? '';
    if (!first && !last && pick.name) ({ first, last } = splitName(pick.name));
    const row: ImportRow = {
      first_name: first, last_name: last, title: pick.title ?? '', company: pick.company ?? '',
      email: (pick.email ?? '').toLowerCase(), linkedin_url: normalizeLinkedIn(pick.linkedin_url ?? ''),
      industry: pick.industry ?? '', company_size: pick.company_size ?? '', website: pick.website ?? '',
    };
    const problem = importProblem(row);
    if (problem) rejected.push({ line: i + 2, reason: problem });
    else rows.push(row);
  });
  return { rows, rejected };
}

/** Rows that are already in the pipeline (same email or LinkedIn URL) and the rest. Harvey checks again on his side. */
export function splitKnown(rows: ImportRow[], existing: HarveyProspect[]): { fresh: ImportRow[]; known: ImportRow[] } {
  const emails = new Set(existing.map((p) => lc(p.data.email)).filter(Boolean));
  const profiles = new Set(existing.map((p) => normalizeLinkedIn(p.data.linkedin_url ?? '').toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const fresh: ImportRow[] = [];
  const known: ImportRow[] = [];
  for (const r of rows) {
    const keys = [r.email && `e:${r.email}`, r.linkedin_url && `l:${r.linkedin_url.toLowerCase()}`].filter(Boolean) as string[];
    const dup = keys.some((k) => seen.has(k)) || (r.email && emails.has(r.email)) || (r.linkedin_url && profiles.has(r.linkedin_url.toLowerCase()));
    keys.forEach((k) => seen.add(k));
    (dup ? known : fresh).push(r);
  }
  return { fresh, known };
}

export const IMPORT_CHUNK = 500;
export const IMPORT_MAX = 2000;

/** Queue the import for Harvey, in commands of at most 500 rows. Returns how many commands were queued. */
export async function queueImport(orgId: string, userId: string, rows: ImportRow[], source: string): Promise<number> {
  if (rows.length === 0) throw new Error('Nothing to import.');
  if (rows.length > IMPORT_MAX) throw new Error(`Import at most ${IMPORT_MAX} rows at a time.`);
  let n = 0;
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
    await sendCommand(orgId, userId, 'import_prospects', { rows: rows.slice(i, i + IMPORT_CHUNK), source: source.trim().slice(0, 80) || 'csv' });
    n += 1;
  }
  return n;
}

const EXPORT_COLUMNS: Array<[string, (p: HarveyProspect) => unknown]> = [
  ['Name', (p) => p.name], ['Title', (p) => p.title], ['Company', (p) => p.company],
  ['Email', (p) => p.data.email], ['LinkedIn URL', (p) => p.data.linkedin_url],
  ['Industry', (p) => p.data.industry], ['Company size', (p) => p.data.company_size],
  ['Stage', (p) => p.stage], ['Score', (p) => p.score], ['Source', (p) => p.data.source],
  ['Email status', (p) => p.email_status], ['Last sent', (p) => p.last_event_at], ['Next step', (p) => p.next_step_at],
];

/** A spreadsheet runs a cell that starts with = + - @ as a formula: neutralise those on the way out. */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function prospectsToCsv(rows: HarveyProspect[]): string {
  const lines = [EXPORT_COLUMNS.map(([h]) => csvCell(h)).join(',')];
  for (const p of rows) lines.push(EXPORT_COLUMNS.map(([, get]) => csvCell(get(p))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// ── funnel ───────────────────────────────────────────────────────────────────────────────────

export interface HarveyFunnel {
  since: string;
  prospects: number;
  stages: Record<string, number>;
  contacted: number;
  replied: number;
  interested: number;
  booked: number;
  by_channel: Record<string, { contacted: number; replied: number }>;
  bookings: Array<{ prospect_id: string; name: string; company: string; meeting_at: string | null; first_contacted_at: string | null }>;
}

export async function getFunnel(orgId: string, sinceDays: number, prospectIds: string[] | null = null): Promise<HarveyFunnel> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data, error } = await supabase.rpc('harvey_funnel', { p_org: orgId, p_since: since, p_prospect_ids: prospectIds });
  if (error) throw fail(error);
  return data as HarveyFunnel;
}

export interface FunnelStep { key: string; label: string; n: number; pctOfPrevious: number | null; pctOfContacted: number | null }

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export function funnelSteps(f: Pick<HarveyFunnel, 'prospects' | 'contacted' | 'replied' | 'interested' | 'booked'>): FunnelStep[] {
  const seq: Array<[string, string, number]> = [
    ['prospects', 'Prospects', f.prospects], ['contacted', 'Contacted', f.contacted], ['replied', 'Replied', f.replied],
    ['interested', 'Interested', f.interested], ['booked', 'Booked', f.booked],
  ];
  return seq.map(([key, label, n], i) => ({
    key, label, n,
    pctOfPrevious: i === 0 ? null : pct(n, seq[i - 1][2]),
    pctOfContacted: key === 'prospects' || key === 'contacted' ? null : pct(n, f.contacted),
  }));
}

// ── safety limits ────────────────────────────────────────────────────────────────────────────

export function limitTone(state: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (state === 'ok') return 'ok';
  if (state === 'near') return 'warn';
  if (state === 'full' || state === 'tripped') return 'bad';
  return 'muted';
}

// ── LinkedIn hand-off ────────────────────────────────────────────────────────────────────────

export async function markLinkedInSent(orgId: string, userId: string, outboxId: string): Promise<void> {
  await sendCommand(orgId, userId, 'linkedin_sent', { outbox_id: outboxId });
}

/** Only real LinkedIn profile links are opened from the page. */
export function safeProfileUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)linkedin\.com$/i.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}
