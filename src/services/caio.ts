/**
 * CAIO Delivery module data: everything a Fractional CAIO delivers to one client.
 *
 * One engagement per project in the CAIO Engagements pipeline (caio_engagements). Its 17 registers live in ONE
 * table (caio_records) whose fields are defined by caio_registers + caio_register_fields; the database validates
 * every value (types, dropdowns, no secrets, no unresolved [PLACEHOLDER]) and issues the stable record keys.
 * Deliverables are caio_documents copied from the 40 caio_templates; approval is blocked while a bold
 * [PLACEHOLDER] remains, and an approved document is revised as a new version. caio_gates holds the five delivery
 * gates (Day 30/60/90, Month 6/12) with their acceptance checklists.
 * Migrations 20261105100000 .. 20261105130000. Reads: owner, SuperAdmins, agents. Writes: owner only (RLS).
 * The pure helpers at the bottom are unit-tested in caio.test.ts.
 */
import { supabase } from '../lib/supabase';

export type FieldType = 'text' | 'longtext' | 'date' | 'number' | 'select';
export type PromoteAs = 'status' | 'risk_tier' | 'owner' | 'system_ref';
export type DocStatus = 'draft' | 'in_review' | 'approved' | 'superseded';
export type GateStatus = 'open' | 'accepted' | 'remediation' | 'stopped';
export type EngagementStatus = 'active' | 'paused' | 'completed';

export interface RegisterField {
  register_key: string;
  field_key: string;
  label: string;
  ftype: FieldType;
  sort: number;
  options: string[] | null;
  promote_as: PromoteAs | null;
  is_id: boolean;
  is_due: boolean;
  client_safe: boolean;
}
export interface RegisterDef {
  register_key: string;
  title: string;
  prefix: string;
  purpose: string;
  sort: number;
  fields: RegisterField[];
}
export interface Engagement {
  id: string;
  org_id: string;
  project_id: string;
  contact_id: string | null;
  engagement_code: string;
  client_legal_name: string;
  executive_sponsor: string;
  register_owner: string;
  kickoff_date: string;
  status: EngagementStatus;
  portal_enabled: boolean;
  notes: string;
}
export interface CaioRecord {
  id: string;
  engagement_id: string;
  register_key: string;
  record_key: string;
  data: Record<string, string | number>;
  status: string | null;
  due_date: string | null;
  risk_tier: string | null;
  owner_name: string | null;
  system_key: string | null;
  client_visible: boolean;
  updated_at: string;
}
export interface RecordHistory {
  id: number;
  op: 'update' | 'delete';
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  changed_by: string | null;
  changed_at: string;
}
export interface CaioTemplate {
  id: string;
  number: number;
  slug: string;
  title: string;
  when_to_use: string;
  milestones: string[];
  feeds: string[];
  body_html: string;
  placeholders: string[];
  version: number;
  source: 'seed' | 'import' | 'edited';
  enabled: boolean;
  updated_at: string;
}
export type CaioTemplateRow = Omit<CaioTemplate, 'body_html'>;
export interface CaioDocument {
  id: string;
  engagement_id: string;
  template_id: string | null;
  template_number: number | null;
  title: string;
  system_key: string | null;
  version: number;
  status: DocStatus;
  body_html: string;
  owner_name: string | null;
  approver_name: string | null;
  approval_ref: string | null;
  approved_at: string | null;
  next_review: string | null;
  evidence_link: string | null;
  client_visible: boolean;
  updated_at: string;
}
export type CaioDocumentRow = Omit<CaioDocument, 'body_html'>;
export interface DocumentVersion {
  id: number;
  version: number;
  status: string;
  body_html: string;
  approver_name: string | null;
  approval_ref: string | null;
  approved_at: string | null;
  changed_at: string;
}
export interface GateCondition { text: string; met: boolean; evidence_link: string; note: string }
export interface GateDef {
  gate_key: string;
  label: string;
  sort: number;
  objective: string;
  deliverables: string;
  required_templates: number[];
}
export interface Gate {
  id: string;
  engagement_id: string;
  gate_key: string;
  due_date: string;
  conditions: GateCondition[];
  status: GateStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}
export interface PortfolioRow {
  engagement_id: string;
  engagement_code: string;
  client_legal_name: string;
  project_id: string;
  status: EngagementStatus;
  kickoff_date: string;
  portal_enabled: boolean;
  next_gate: { gate_key: string; label: string; due_date: string; status: GateStatus; met: number; total: number } | null;
  next_gate_due: string | null;
  overdue_actions: number;
  exceptions_expiring_30d: number;
  exceptions_expired: number;
  open_incidents: number;
  reviews_overdue: number;
  documents_in_progress: number;
  documents_review_overdue: number;
  systems: number;
}
export interface Coverage {
  inventoried: number;
  covered: number;
  pct: number | null;
  gaps: { system: string; name: string | null; missing: string[] }[];
}

const MIGRATION_HINT = 'The CAIO module is not available yet: the CAIO migrations (20261105100000 onward) have not been applied to this database.';

function fail(error: { message?: string; code?: string } | null): Error {
  const msg = error?.message ?? 'Request failed';
  if (error?.code === 'PGRST205' || error?.code === 'PGRST202' || error?.code === '42P01' || error?.code === '42883'
    || /could not find the (table|function)|does not exist/i.test(msg)) return new Error(MIGRATION_HINT);
  // trigger messages come back as "caio_records: <what is wrong>": show only the useful part
  return new Error(msg.replace(/^caio_[a-z_]+:\s*/, ''));
}

const REG_COLS = 'register_key,title,prefix,purpose,sort';
const FIELD_COLS = 'register_key,field_key,label,ftype,sort,options,promote_as,is_id,is_due,client_safe';
const ENG_COLS = 'id,org_id,project_id,contact_id,engagement_code,client_legal_name,executive_sponsor,register_owner,kickoff_date,status,portal_enabled,notes';
const REC_COLS = 'id,engagement_id,register_key,record_key,data,status,due_date,risk_tier,owner_name,system_key,client_visible,updated_at';
const TPL_ROW_COLS = 'id,number,slug,title,when_to_use,milestones,feeds,placeholders,version,source,enabled,updated_at';
const DOC_ROW_COLS = 'id,engagement_id,template_id,template_number,title,system_key,version,status,owner_name,approver_name,approval_ref,approved_at,next_review,evidence_link,client_visible,updated_at';

// ── reference data ──────────────────────────────────────────────────────────────────────────

let defsCache: RegisterDef[] | null = null;

/** The 17 registers with their fields, in workbook order. Cached for the session (global reference data). */
export async function listRegisterDefs(force = false): Promise<RegisterDef[]> {
  if (defsCache && !force) return defsCache;
  const [r, f] = await Promise.all([
    supabase.from('caio_registers').select(REG_COLS).order('sort'),
    supabase.from('caio_register_fields').select(FIELD_COLS).order('sort'),
  ]);
  if (r.error) throw fail(r.error);
  if (f.error) throw fail(f.error);
  const fields = (f.data ?? []) as RegisterField[];
  defsCache = ((r.data ?? []) as Omit<RegisterDef, 'fields'>[]).map((reg) => ({
    ...reg, fields: fields.filter((x) => x.register_key === reg.register_key).sort((a, b) => a.sort - b.sort),
  }));
  return defsCache;
}

export async function listGateDefs(): Promise<GateDef[]> {
  const { data, error } = await supabase.from('caio_gate_defs').select('gate_key,label,sort,objective,deliverables,required_templates').order('sort');
  if (error) throw fail(error);
  return (data ?? []) as GateDef[];
}

// ── engagements ─────────────────────────────────────────────────────────────────────────────

export async function getEngagementByProject(projectId: string): Promise<Engagement | null> {
  const { data, error } = await supabase.from('caio_engagements').select(ENG_COLS).eq('project_id', projectId).maybeSingle();
  if (error) throw fail(error);
  return (data as Engagement | null) ?? null;
}

export interface StartEngagementInput { kickoff?: string; clientLegalName?: string; executiveSponsor?: string; registerOwner?: string }

/** Open an engagement on a project: engagement code, five dated gates with their acceptance checklists. */
export async function startEngagement(projectId: string, input: StartEngagementInput = {}): Promise<string> {
  const { data, error } = await supabase.rpc('caio_start_engagement', {
    p_project_id: projectId, p_kickoff: input.kickoff ?? todayIso(), p_client_legal_name: input.clientLegalName ?? null,
    p_executive_sponsor: input.executiveSponsor ?? null, p_register_owner: input.registerOwner ?? null,
  });
  if (error) throw fail(error);
  return data as string;
}

/** From a contact: creates the assessment project (with its dated tasks) and opens the engagement on it. */
export async function startFromContact(contactId: string, input: StartEngagementInput & { opportunityId?: string } = {}): Promise<string> {
  const { data, error } = await supabase.rpc('caio_start_from_contact', {
    p_contact_id: contactId, p_kickoff: input.kickoff ?? todayIso(), p_opportunity_id: input.opportunityId ?? null,
    p_client_legal_name: input.clientLegalName ?? null, p_executive_sponsor: input.executiveSponsor ?? null, p_register_owner: input.registerOwner ?? null,
  });
  if (error) throw fail(error);
  return data as string;
}

export type EngagementPatch = Partial<Pick<Engagement, 'client_legal_name' | 'executive_sponsor' | 'register_owner' | 'status' | 'portal_enabled' | 'notes' | 'kickoff_date'>>;

export async function updateEngagement(id: string, patch: EngagementPatch): Promise<void> {
  const { error } = await supabase.from('caio_engagements').update(patch).eq('id', id);
  if (error) throw fail(error);
}

export async function getPortfolio(): Promise<PortfolioRow[]> {
  const { data, error } = await supabase.rpc('caio_portfolio');
  if (error) throw fail(error);
  return (Array.isArray(data) ? data : []) as PortfolioRow[];
}

export async function getCoverage(engagementId: string): Promise<Coverage> {
  const { data, error } = await supabase.rpc('caio_governance_coverage', { p_engagement: engagementId });
  if (error) throw fail(error);
  return data as Coverage;
}

// ── records ─────────────────────────────────────────────────────────────────────────────────

export async function listRecords(engagementId: string, registerKey?: string): Promise<CaioRecord[]> {
  let q = supabase.from('caio_records').select(REC_COLS).eq('engagement_id', engagementId);
  if (registerKey) q = q.eq('register_key', registerKey);
  const { data, error } = await q.order('record_key').limit(5000);
  if (error) throw fail(error);
  return (data ?? []) as CaioRecord[];
}

/** Count per register for the sub-tab badges. */
export async function recordCounts(engagementId: string): Promise<Record<string, number>> {
  const rows = await listRecords(engagementId);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.register_key] = (out[r.register_key] ?? 0) + 1;
  return out;
}

export async function createRecord(orgId: string, engagementId: string, registerKey: string, data: Record<string, unknown>, clientVisible = false): Promise<CaioRecord> {
  const { data: row, error } = await supabase.from('caio_records')
    .insert({ org_id: orgId, engagement_id: engagementId, register_key: registerKey, data: cleanData(data), client_visible: clientVisible })
    .select(REC_COLS).single();
  if (error) throw fail(error);
  return row as CaioRecord;
}

export async function updateRecord(id: string, patch: { data?: Record<string, unknown>; client_visible?: boolean }): Promise<CaioRecord> {
  const body: Record<string, unknown> = {};
  if (patch.data) body.data = cleanData(patch.data);
  if (patch.client_visible !== undefined) body.client_visible = patch.client_visible;
  const { data: row, error } = await supabase.from('caio_records').update(body).eq('id', id).select(REC_COLS).single();
  if (error) throw fail(error);
  return row as CaioRecord;
}

export async function deleteRecord(id: string): Promise<void> {
  const { error } = await supabase.from('caio_records').delete().eq('id', id);
  if (error) throw fail(error);
}

export async function recordHistory(recordId: string): Promise<RecordHistory[]> {
  const { data, error } = await supabase.from('caio_record_history')
    .select('id,op,old_data,new_data,changed_by,changed_at').eq('record_id', recordId).order('changed_at', { ascending: false }).limit(50);
  if (error) throw fail(error);
  return (data ?? []) as RecordHistory[];
}

/** Show or hide a whole register to the client (every row in it). */
export async function setRegisterClientVisible(engagementId: string, registerKey: string, visible: boolean): Promise<void> {
  const { error } = await supabase.from('caio_records').update({ client_visible: visible }).eq('engagement_id', engagementId).eq('register_key', registerKey);
  if (error) throw fail(error);
}

export interface ImportResult { created: number; failed: { row: number; message: string }[] }

/** Insert parsed rows one by one so a bad row is reported, not fatal. */
export async function importRecords(orgId: string, engagementId: string, registerKey: string, rows: Record<string, string>[]): Promise<ImportResult> {
  const res: ImportResult = { created: 0, failed: [] };
  for (let i = 0; i < rows.length; i++) {
    try { await createRecord(orgId, engagementId, registerKey, rows[i]); res.created++; }
    catch (e) { res.failed.push({ row: i + 2, message: e instanceof Error ? e.message : String(e) }); }
  }
  return res;
}

// ── templates ───────────────────────────────────────────────────────────────────────────────

export async function listTemplates(): Promise<CaioTemplateRow[]> {
  const { data, error } = await supabase.from('caio_templates').select(TPL_ROW_COLS).order('number');
  if (error) throw fail(error);
  return (data ?? []) as CaioTemplateRow[];
}

export async function getTemplate(id: string): Promise<CaioTemplate | null> {
  const { data, error } = await supabase.from('caio_templates').select(`${TPL_ROW_COLS},body_html`).eq('id', id).maybeSingle();
  if (error) throw fail(error);
  return (data as CaioTemplate | null) ?? null;
}

/** Owner only. Editing bumps the version and marks the template 'edited' (re-seeding then leaves it alone). */
export async function updateTemplate(id: string, patch: { body_html?: string; title?: string; when_to_use?: string; enabled?: boolean }): Promise<void> {
  const { error } = await supabase.from('caio_templates').update(patch).eq('id', id);
  if (error) throw fail(error);
}

/** Replace a template's body from an uploaded .docx (HTML from mammoth). Source becomes 'import'. */
export async function importTemplateBody(id: string, html: string): Promise<void> {
  const { error } = await supabase.from('caio_templates').update({ body_html: html, source: 'import' }).eq('id', id);
  if (error) throw fail(error);
}

// ── documents ───────────────────────────────────────────────────────────────────────────────

export async function listDocuments(engagementId: string): Promise<CaioDocumentRow[]> {
  const { data, error } = await supabase.from('caio_documents').select(DOC_ROW_COLS).eq('engagement_id', engagementId).order('template_number', { nullsFirst: false }).order('title');
  if (error) throw fail(error);
  return (data ?? []) as CaioDocumentRow[];
}

export async function getDocument(id: string): Promise<CaioDocument | null> {
  const { data, error } = await supabase.from('caio_documents').select(`${DOC_ROW_COLS},body_html`).eq('id', id).maybeSingle();
  if (error) throw fail(error);
  return (data as CaioDocument | null) ?? null;
}

/** A client's copy of a template, pre-filled with what the engagement already knows (client, engagement code). */
export async function createDocumentFromTemplate(
  engagement: Engagement, template: CaioTemplate, opts: { title?: string; systemKey?: string | null; owner?: string | null } = {},
): Promise<CaioDocument> {
  const html = prefillTemplate(template.body_html, {
    'CLIENT LEGAL NAME': engagement.client_legal_name, 'ENGAGEMENT ID': engagement.engagement_code,
    ...(opts.systemKey ? { 'SYSTEM ID': opts.systemKey } : {}), VERSION: '1', STATUS: 'Draft',
  });
  const { data, error } = await supabase.from('caio_documents').insert({
    org_id: engagement.org_id, engagement_id: engagement.id, template_id: template.id, template_number: template.number,
    title: opts.title?.trim() || `${template.title}${opts.systemKey ? ` (${opts.systemKey})` : ''}`, system_key: opts.systemKey ?? null,
    owner_name: opts.owner ?? engagement.register_owner ?? null, body_html: html,
  }).select(`${DOC_ROW_COLS},body_html`).single();
  if (error) throw fail(error);
  return data as CaioDocument;
}

export type DocumentPatch = Partial<Pick<CaioDocument, 'title' | 'body_html' | 'status' | 'owner_name' | 'approver_name' | 'approval_ref' | 'next_review' | 'evidence_link' | 'client_visible' | 'system_key'>>;

export async function updateDocument(id: string, patch: DocumentPatch): Promise<void> {
  const { error } = await supabase.from('caio_documents').update(patch).eq('id', id);
  if (error) throw fail(error);
}

export async function approveDocument(id: string, a: { approver: string; ref: string; nextReview: string }): Promise<void> {
  await updateDocument(id, { status: 'approved', approver_name: a.approver, approval_ref: a.ref, next_review: a.nextReview });
}

/** An approved document is revised as version N+1 (the approved text stays in its version history). */
export async function reviseDocument(id: string): Promise<number> {
  const { data, error } = await supabase.rpc('caio_revise_document', { p_id: id });
  if (error) throw fail(error);
  return data as number;
}

export async function deleteDocument(id: string): Promise<void> {
  const { error } = await supabase.from('caio_documents').delete().eq('id', id).neq('status', 'approved');
  if (error) throw fail(error);
}

export async function documentVersions(documentId: string): Promise<DocumentVersion[]> {
  const { data, error } = await supabase.from('caio_document_versions')
    .select('id,version,status,body_html,approver_name,approval_ref,approved_at,changed_at').eq('document_id', documentId).order('changed_at', { ascending: false });
  if (error) throw fail(error);
  return (data ?? []) as DocumentVersion[];
}

// ── gates ───────────────────────────────────────────────────────────────────────────────────

export async function listGates(engagementId: string): Promise<Gate[]> {
  const { data, error } = await supabase.from('caio_gates')
    .select('id,engagement_id,gate_key,due_date,conditions,status,decided_by,decided_at,decision_note').eq('engagement_id', engagementId).order('due_date');
  if (error) throw fail(error);
  return (data ?? []) as Gate[];
}

export async function updateGate(id: string, patch: Partial<Pick<Gate, 'conditions' | 'status' | 'decided_by' | 'decision_note' | 'due_date'>>): Promise<void> {
  const { error } = await supabase.from('caio_gates').update(patch).eq('id', id);
  if (error) throw fail(error);
}

// ── pure helpers (unit-tested) ───────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /<(?:strong|b)>\s*\[([A-Z0-9][A-Z0-9 /&'.,()-]*)\]\s*<\/(?:strong|b)>/g;

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Distinct bold [PLACEHOLDER] prompts still in a document, in order of first appearance. */
export function unresolvedPlaceholders(html: string): string[] {
  const seen: string[] = [];
  for (const m of html.matchAll(PLACEHOLDER_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

export function placeholderCount(html: string, name: string): number {
  let n = 0;
  for (const m of html.matchAll(PLACEHOLDER_RE)) if (m[1] === name) n++;
  return n;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Replace EVERY occurrence of one placeholder with a value (escaped). N/A needs a reason: the caller composes it. */
export function fillPlaceholder(html: string, name: string, value: string): string {
  const v = escapeHtml(value.trim());
  return html.replace(PLACEHOLDER_RE, (whole, n: string) => (n === name ? v : whole));
}

export function prefillTemplate(html: string, values: Record<string, string>): string {
  let out = html;
  for (const [k, v] of Object.entries(values)) if (v && v.trim()) out = fillPlaceholder(out, k, v);
  return out;
}

/** Can this document be approved yet? Returns what is missing, empty when it can. */
export function approvalBlockers(doc: Pick<CaioDocument, 'body_html' | 'approver_name' | 'approval_ref' | 'next_review'>): string[] {
  const out: string[] = [];
  const left = unresolvedPlaceholders(doc.body_html);
  if (left.length) out.push(`${left.length} placeholder${left.length === 1 ? '' : 's'} still to fill (first: ${left[0]})`);
  if (!doc.approver_name?.trim()) out.push('approver');
  if (!doc.approval_ref?.trim()) out.push('approval reference');
  if (!doc.next_review) out.push('next review date');
  return out;
}

/** Whole days from today to a date (negative = overdue). Null for no date. */
export function daysUntil(date: string | null, now = new Date()): number | null {
  if (!date) return null;
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - a) / 86_400_000);
}

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

/** How a due/review date should look: overdue = bad, within 14 days = warn. */
export function dueTone(date: string | null, now = new Date()): Tone {
  const d = daysUntil(date, now);
  if (d === null) return 'muted';
  if (d < 0) return 'bad';
  return d <= 14 ? 'warn' : 'good';
}

export function gateProgress(g: Pick<Gate, 'conditions'>): { met: number; total: number } {
  return { met: g.conditions.filter((c) => c.met).length, total: g.conditions.length };
}

/** Accepting with unmet conditions needs a written decision (the database enforces it too). */
export function gateAcceptBlockers(g: Pick<Gate, 'conditions' | 'decided_by' | 'decision_note'>): string[] {
  const out: string[] = [];
  if (!g.decided_by?.trim()) out.push('who is deciding');
  const { met, total } = gateProgress(g);
  if (met < total && !g.decision_note?.trim()) out.push(`a written decision for the ${total - met} unmet condition${total - met === 1 ? '' : 's'}`);
  return out;
}

export function gateTone(g: Pick<Gate, 'status' | 'due_date'>, now = new Date()): Tone {
  if (g.status === 'accepted') return 'good';
  if (g.status === 'stopped') return 'muted';
  if (g.status === 'remediation') return 'warn';
  return dueTone(g.due_date, now);
}

/** Drop blank values; the database does the real validation. */
export function cleanData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

export function isPlaceholderValue(v: string): boolean {
  return /^\s*\[[A-Z0-9][A-Z0-9 /&'.,()-]*\]\s*$/.test(v);
}

// ── CSV (workbook export / import) ──────────────────────────────────────────────────────────

/** RFC 4180 style parser: quoted fields, doubled quotes, CRLF or LF, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function recordsToCsv(def: RegisterDef, records: Pick<CaioRecord, 'data'>[]): string {
  const head = def.fields.map((f) => csvEscape(f.label)).join(',');
  const lines = records.map((r) => def.fields.map((f) => csvEscape(r.data[f.field_key])).join(','));
  return [head, ...lines].join('\r\n');
}

export interface CsvMapping {
  /** header (as in the file) -> field_key; headers that match no column of the register are listed in `ignored` */
  columns: Record<string, string>;
  ignored: string[];
  rows: Record<string, string>[];
  /** rows skipped because they were the workbook's untouched [PLACEHOLDER] row or empty */
  skipped: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Map a CSV (exported from the workbook tab or from this module) onto a register: headers match column labels
 * ignoring case and punctuation. The workbook's explanation row and the untouched [PLACEHOLDER] row are skipped.
 */
export function mapCsv(def: RegisterDef, text: string): CsvMapping {
  const table = parseCsv(text);
  const byLabel = new Map(def.fields.map((f) => [norm(f.label), f.field_key]));
  // the workbook export has title/description rows above the header: use the first row that matches 3+ labels
  let h = table.findIndex((r) => r.filter((c) => byLabel.has(norm(c))).length >= Math.min(3, def.fields.length));
  if (h < 0) h = 0;
  const header = table[h] ?? [];
  const columns: Record<string, string> = {};
  const ignored: string[] = [];
  header.forEach((c) => { const k = byLabel.get(norm(c)); if (k) columns[c] = k; else if (c.trim()) ignored.push(c.trim()); });
  const rows: Record<string, string>[] = [];
  let skipped = 0;
  for (const r of table.slice(h + 1)) {
    const rec: Record<string, string> = {};
    header.forEach((c, i) => { const k = columns[c]; const v = (r[i] ?? '').trim(); if (k && v) rec[k] = v; });
    const values = Object.values(rec);
    if (!values.length || values.every(isPlaceholderValue) || values.some((v) => /^\[(REPLACE|ENTER) [A-Z ]*BELOW\]$/.test(v))) { skipped++; continue; }
    rows.push(rec);
  }
  return { columns, ignored, rows, skipped };
}
