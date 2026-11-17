/**
 * CAIO deliverable automation: the company profile (facts), uploaded/linked sources, extraction proposals,
 * "needs your input", generation jobs and the per-value provenance of auto-filled document text.
 * Migration 20261106100000. Owner-only screens; the database enforces access (RLS) and the validated write paths
 * (caio_accept_proposal, caio_confirm_fact). Edge functions: caio-source-ingest, caio-generate.
 * Pure screen logic lives in components/caio/automationLogic.ts.
 */
import { supabase } from '../lib/supabase';

export type FactSource = 'user' | 'interview' | 'public_research' | 'crm' | 'computed';
export type FactStatus = 'proposed' | 'confirmed' | 'rejected' | 'stale';
export type SourceKind = 'transcript' | 'summary' | 'interview_notes' | 'public_research' | 'policy' | 'other';
export type ProcessStatus = 'ready' | 'needs_review' | 'blocked';
export type ExtractionStatus = 'pending' | 'running' | 'done' | 'failed' | 'no_text' | 'skipped';
export type FieldStatus = 'auto' | 'confirmed' | 'edited' | 'rejected';

export interface FactDef {
  fact_key: string;
  label: string;
  grp: string;
  type: 'text' | 'longtext' | 'number' | 'date';
  help: string;
  sort: number;
  profile_minimum: boolean;
  templates: number[];
}
export interface Fact {
  id: string;
  engagement_id: string;
  fact_key: string;
  value: string;
  source: FactSource;
  source_id: string | null;
  evidence_quote: string | null;
  status: FactStatus;
  confirmed_at: string | null;
  updated_at: string;
}
export interface PiiFlag { type: string; count?: number }
export interface CaioSource {
  id: string;
  engagement_id: string;
  kind: SourceKind;
  title: string;
  department: string | null;
  interviewees: string | null;
  meeting_transcription_id: string | null;
  original_filename: string | null;
  char_count: number;
  pii_flags: PiiFlag[];
  process_status: ProcessStatus;
  consent_attested_at: string | null;
  extraction_status: ExtractionStatus;
  extraction_error: string | null;
  created_at: string;
}
export interface MeetingOption { id: string; meeting_title: string | null; meeting_date: string | null }
export interface NeedsLinkMeeting { id: string; meeting_transcription_id: string; meeting: MeetingOption | null; created_at: string }
export interface Proposal {
  id: string;
  engagement_id: string;
  source_id: string;
  kind: 'fact' | 'record';
  fact_key: string | null;
  register_key: string | null;
  payload: Record<string, unknown>;
  summary: string;
  evidence_quote: string;
  confidence: 'high' | 'medium' | 'low';
  flags: string[];
  status: string;
  created_at: string;
  source: { title: string; kind: SourceKind } | null;
}
export interface InputRequest {
  id: string;
  engagement_id: string;
  kind: 'fact' | 'register';
  key: string;
  label: string;
  why: string;
  blocks_templates: number[];
  status: 'open' | 'resolved' | 'dismissed';
}
export interface GenerationJob { id: string; status: string; last_error: string | null; created_at: string; finished_at: string | null }
export interface DocumentField {
  id: string;
  document_id: string;
  mark_id: string;
  placeholder: string;
  value: string;
  resolver: string;
  source_ref: string;
  confidence: 'high' | 'medium' | 'low' | null;
  status: FieldStatus;
}
export interface PlaceholderDef { name: string; resolver: string }
export interface GenerateResult {
  ok: boolean;
  document_id?: string;
  filled?: number;
  unresolved?: { name: string; resolver: string }[];
  needs_input?: { kind: string; key: string; label: string }[];
  created?: boolean;
  error?: string;
}
export interface IngestResult {
  ok: boolean;
  sources: { id: string; title: string; process_status: ProcessStatus; extraction_status: ExtractionStatus; pii_flags: PiiFlag[]; char_count: number }[];
  skipped: { filename: string; reason: string }[];
  error?: string;
}

const MIGRATION_HINT = 'CAIO automation is not available yet: migration 20261106100000 has not been applied to this database.';

function fail(error: { message?: string; code?: string } | null): Error {
  const msg = error?.message ?? 'Request failed';
  if (error?.code === 'PGRST205' || error?.code === 'PGRST202' || error?.code === '42P01' || error?.code === '42883'
    || /could not find the (table|function)|does not exist/i.test(msg)) return new Error(MIGRATION_HINT);
  // trigger messages come back as "caio_facts: <what is wrong>": show only the useful part, verbatim otherwise
  return new Error(msg.replace(/^caio_[a-z_]+:\s*/, ''));
}

/** The message of a failed edge-function call: the JSON body's error when there is one, else the client's message. */
export async function edgeErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === 'function') {
    try {
      const body = await (ctx as Response).clone().json() as { error?: unknown; message?: unknown };
      const m = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : '';
      if (m) return m;
    } catch { /* not JSON */ }
  }
  return error instanceof Error && error.message ? error.message : 'The request failed';
}

const FACT_COLS = 'id,engagement_id,fact_key,value,source,source_id,evidence_quote,status,confirmed_at,updated_at';
const SOURCE_COLS = 'id,engagement_id,kind,title,department,interviewees,meeting_transcription_id,original_filename,char_count,pii_flags,process_status,consent_attested_at,extraction_status,extraction_error,created_at';
const PROPOSAL_COLS = 'id,engagement_id,source_id,kind,fact_key,register_key,payload,summary,evidence_quote,confidence,flags,status,created_at,source:caio_sources(title,kind)';

// ── company profile ─────────────────────────────────────────────────────────────────────────

export async function listFactDefs(): Promise<FactDef[]> {
  const { data, error } = await supabase.from('caio_fact_defs').select('fact_key,label,grp,type,help,sort,profile_minimum,templates').order('sort');
  if (error) throw fail(error);
  return (data ?? []) as FactDef[];
}

export async function listFacts(engagementId: string): Promise<Fact[]> {
  const { data, error } = await supabase.from('caio_facts').select(FACT_COLS).eq('engagement_id', engagementId).neq('status', 'rejected');
  if (error) throw fail(error);
  return (data ?? []) as Fact[];
}

/** The owner types a value: saved as a confirmed fact from the owner (source 'user'). Replaces any proposed value. */
export async function saveFact(orgId: string, engagementId: string, factKey: string, value: string): Promise<void> {
  const { error } = await supabase.from('caio_facts').upsert(
    { org_id: orgId, engagement_id: engagementId, fact_key: factKey, value: value.trim(), source: 'user', source_id: null, evidence_quote: null, status: 'confirmed' },
    { onConflict: 'engagement_id,fact_key' },
  );
  if (error) throw fail(error);
}

/** Confirm a proposed fact as it stands (or with a corrected value). */
export async function confirmFact(id: string, value?: string): Promise<void> {
  const { error } = await supabase.rpc('caio_confirm_fact', { p_id: id, p_value: value ?? null });
  if (error) throw fail(error);
}

// ── sources ─────────────────────────────────────────────────────────────────────────────────

export async function listSources(engagementId: string): Promise<CaioSource[]> {
  const { data, error } = await supabase.from('caio_sources').select(SOURCE_COLS).eq('engagement_id', engagementId).order('created_at', { ascending: false }).limit(200);
  if (error) throw fail(error);
  return (data ?? []) as CaioSource[];
}

export interface UploadInput { engagementId: string; files: File[]; kind: SourceKind; department?: string; interviewees?: string; consent: boolean }

/** Multipart upload to caio-source-ingest. `consent` is sent as "true" only when the owner ticked the box. */
export async function uploadSources(input: UploadInput): Promise<IngestResult> {
  const form = new FormData();
  form.append('engagement_id', input.engagementId);
  form.append('kind', input.kind);
  if (input.department?.trim()) form.append('department', input.department.trim());
  if (input.interviewees?.trim()) form.append('interviewees', input.interviewees.trim());
  form.append('consent', input.consent ? 'true' : 'false');
  for (const f of input.files) form.append('files[]', f, f.name);
  const { data, error } = await supabase.functions.invoke('caio-source-ingest', { body: form });
  if (error) throw new Error(await edgeErrorMessage(error));
  const res = data as IngestResult;
  if (!res?.ok) throw new Error(res?.error ?? 'The upload was not accepted');
  return res;
}

async function ingestAction(body: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase.functions.invoke('caio-source-ingest', { body });
  if (error) throw new Error(await edgeErrorMessage(error));
  const res = data as { ok?: boolean; error?: string } | null;
  if (res && res.ok === false) throw new Error(res.error ?? 'The request was not accepted');
}

export const allowSource = (sourceId: string) => ingestAction({ action: 'allow-source', source_id: sourceId });
export const blockSource = (sourceId: string) => ingestAction({ action: 'block-source', source_id: sourceId });
export const ignoreMeeting = (meetingTranscriptionId: string) => ingestAction({ action: 'ignore-meeting', meeting_transcription_id: meetingTranscriptionId });
export const linkMeeting = (engagementId: string, meetingTranscriptionId: string, opts: { consent: boolean; department?: string; consentNote?: string }) =>
  ingestAction({
    action: 'link-meeting', engagement_id: engagementId, meeting_transcription_id: meetingTranscriptionId, consent: opts.consent,
    ...(opts.consentNote?.trim() ? { consent_note: opts.consentNote.trim() } : {}), ...(opts.department?.trim() ? { department: opts.department.trim() } : {}),
  });

/** Recent OS meetings that are not linked to any CAIO engagement yet. */
export async function listLinkableMeetings(limit = 30): Promise<MeetingOption[]> {
  const [m, l] = await Promise.all([
    supabase.from('meeting_transcriptions').select('id,meeting_title,meeting_date').order('meeting_date', { ascending: false }).limit(limit + 40),
    supabase.from('caio_meeting_links').select('meeting_transcription_id').in('state', ['linked', 'ignored']),
  ]);
  if (m.error) throw fail(m.error);
  if (l.error) throw fail(l.error);
  const taken = new Set((l.data ?? []).map((r) => (r as { meeting_transcription_id: string }).meeting_transcription_id));
  return ((m.data ?? []) as MeetingOption[]).filter((x) => !taken.has(x.id)).slice(0, limit);
}

/** Meetings the watcher could not match to a client. */
export async function listNeedsLink(): Promise<NeedsLinkMeeting[]> {
  const { data, error } = await supabase.from('caio_meeting_links')
    .select('id,meeting_transcription_id,created_at,meeting:meeting_transcriptions(id,meeting_title,meeting_date)').eq('state', 'needs_link').order('created_at', { ascending: false }).limit(50);
  if (error) throw fail(error);
  return ((data ?? []) as unknown as (Omit<NeedsLinkMeeting, 'meeting'> & { meeting: MeetingOption | MeetingOption[] | null })[])
    .map((r) => ({ ...r, meeting: Array.isArray(r.meeting) ? r.meeting[0] ?? null : r.meeting }));
}

// ── proposals (Inbox) ───────────────────────────────────────────────────────────────────────

export async function listOpenProposals(engagementId: string): Promise<Proposal[]> {
  const { data, error } = await supabase.from('caio_proposals').select(PROPOSAL_COLS).eq('engagement_id', engagementId).eq('status', 'proposed').order('created_at', { ascending: false }).limit(500);
  if (error) throw fail(error);
  return ((data ?? []) as unknown as (Omit<Proposal, 'source'> & { source: Proposal['source'] | Proposal['source'][] })[])
    .map((p) => ({ ...p, source: Array.isArray(p.source) ? p.source[0] ?? null : p.source }));
}

/** Accept as extracted, or with the owner's corrected payload. The database validates and reports problems verbatim. */
export async function acceptProposal(id: string, edit?: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase.rpc('caio_accept_proposal', { p_id: id, p_edit: edit ?? null });
  if (error) throw fail(error);
  const res = data as { ok?: boolean; error?: string; status?: string } | null;
  if (res && res.ok === false) throw new Error(res.error === 'already_decided' ? `This suggestion was already ${res.status ?? 'decided'}.` : res.error ?? 'Could not accept the suggestion');
}

export async function rejectProposal(id: string): Promise<void> {
  const { error } = await supabase.rpc('caio_reject_proposal', { p_id: id });
  if (error) throw fail(error);
}

// ── needs your input ────────────────────────────────────────────────────────────────────────

export async function listOpenInputRequests(engagementId: string): Promise<InputRequest[]> {
  const { data, error } = await supabase.from('caio_input_requests').select('id,engagement_id,kind,key,label,why,blocks_templates,status').eq('engagement_id', engagementId).eq('status', 'open');
  if (error) throw fail(error);
  return (data ?? []) as InputRequest[];
}

export async function dismissInputRequest(id: string): Promise<void> {
  const { error } = await supabase.from('caio_input_requests').update({ status: 'dismissed' }).eq('id', id);
  if (error) throw fail(error);
}

/** A fact request is satisfied once the owner has entered the fact. */
export async function resolveInputRequest(id: string): Promise<void> {
  const { error } = await supabase.from('caio_input_requests').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', id);
  if (error) throw fail(error);
}

// ── automation switch and jobs ──────────────────────────────────────────────────────────────

export async function getAutomationEnabled(engagementId: string): Promise<boolean> {
  const { data, error } = await supabase.from('caio_engagements').select('automation_enabled').eq('id', engagementId).maybeSingle();
  if (error) throw fail(error);
  return Boolean((data as { automation_enabled?: boolean } | null)?.automation_enabled);
}

export async function setAutomationEnabled(engagementId: string, on: boolean): Promise<void> {
  const { error } = await supabase.from('caio_engagements').update({ automation_enabled: on }).eq('id', engagementId);
  if (error) throw fail(error);
}

export async function getProcessPersonalData(engagementId: string): Promise<boolean> {
  const { data, error } = await supabase.from('caio_engagements').select('process_personal_data').eq('id', engagementId).maybeSingle();
  if (error) throw fail(error);
  return Boolean((data as { process_personal_data?: boolean } | null)?.process_personal_data);
}

export async function setProcessPersonalData(engagementId: string, on: boolean): Promise<void> {
  const { error } = await supabase.from('caio_engagements').update({ process_personal_data: on }).eq('id', engagementId);
  if (error) throw fail(error);
}

export async function listActiveJobs(engagementId: string): Promise<GenerationJob[]> {
  const { data, error } = await supabase.from('caio_generation_jobs').select('id,status,last_error,created_at,finished_at')
    .eq('engagement_id', engagementId).in('status', ['queued', 'running', 'failed']).order('created_at', { ascending: false }).limit(200);
  if (error) throw fail(error);
  return (data ?? []) as GenerationJob[];
}

// ── generation ──────────────────────────────────────────────────────────────────────────────

export interface GenerateInput { engagementId: string; templateNumber: number; systemKey?: string | null; documentId?: string }

/** Draft (or regenerate, keeping what the owner confirmed) one document with caio-generate. */
export async function generateDocument(input: GenerateInput): Promise<GenerateResult> {
  const { data, error } = await supabase.functions.invoke('caio-generate', {
    body: {
      engagement_id: input.engagementId, template_number: input.templateNumber,
      ...(input.systemKey ? { system_key: input.systemKey } : {}), ...(input.documentId ? { document_id: input.documentId } : {}),
    },
  });
  if (error) throw new Error(await edgeErrorMessage(error));
  const res = data as GenerateResult;
  if (!res?.ok) throw new Error(res?.error === 'approved_use_revise' ? 'This document is approved. Revise it first to start a new version.' : res?.error ?? 'The draft could not be prepared');
  return res;
}

// ── document provenance ─────────────────────────────────────────────────────────────────────

export async function listDocumentFields(documentId: string): Promise<DocumentField[]> {
  const { data, error } = await supabase.from('caio_document_fields').select('id,document_id,mark_id,placeholder,value,resolver,source_ref,confidence,status').eq('document_id', documentId);
  if (error) throw fail(error);
  return (data ?? []) as DocumentField[];
}

export async function setDocumentFieldStatus(documentId: string, markId: string, status: 'confirmed' | 'edited', value?: string): Promise<void> {
  const { error } = await supabase.from('caio_document_fields').update({ status, ...(value !== undefined ? { value } : {}), updated_at: new Date().toISOString() })
    .eq('document_id', documentId).eq('mark_id', markId);
  if (error) throw fail(error);
}

/** document id -> generated_at (not part of the base document columns). */
export async function listGeneratedAt(engagementId: string): Promise<Record<string, string | null>> {
  const { data, error } = await supabase.from('caio_documents').select('id,generated_at').eq('engagement_id', engagementId);
  if (error) throw fail(error);
  const out: Record<string, string | null> = {};
  for (const r of (data ?? []) as { id: string; generated_at: string | null }[]) out[r.id] = r.generated_at;
  return out;
}

/** The most recent change to any fact, record or source of the engagement (three tiny queries): the cheap stale check. */
export async function latestInputUpdate(engagementId: string): Promise<string | null> {
  const newest = async (table: string): Promise<string | null> => {
    const { data, error } = await supabase.from(table).select('updated_at').eq('engagement_id', engagementId).order('updated_at', { ascending: false }).limit(1);
    if (error) throw fail(error);
    return ((data ?? [])[0] as { updated_at?: string } | undefined)?.updated_at ?? null;
  };
  const all = await Promise.all([newest('caio_facts'), newest('caio_records'), newest('caio_sources')]);
  let best: string | null = null;
  for (const v of all) if (v && (!best || Date.parse(v) > Date.parse(best))) best = v;
  return best;
}

export interface DraftBody { id: string; title: string; template_number: number | null; status: 'draft' | 'in_review'; body_html: string }

/** Draft and in-review documents with their bodies (for the sign-off queue). */
export async function listDraftBodies(engagementId: string): Promise<DraftBody[]> {
  const { data, error } = await supabase.from('caio_documents').select('id,title,template_number,status,body_html')
    .eq('engagement_id', engagementId).in('status', ['draft', 'in_review']).order('template_number', { nullsFirst: false });
  if (error) throw fail(error);
  return (data ?? []) as DraftBody[];
}

export async function listPlaceholderResolvers(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('caio_placeholder_defs').select('name,resolver');
  if (error) throw fail(error);
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as PlaceholderDef[]) out[r.name] = r.resolver;
  return out;
}
