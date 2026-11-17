import { supabase } from '../lib/supabase';
import { callEdgeFunction } from '../lib/edgeFunction';
import type { DriveFile, MeetingTranscription } from '../types';

/**
 * Source pickers for the AI proposal / contract builders: documents attached to the deal, the
 * client and linked projects (incl. SAM.gov solicitation files), File Manager search, projects,
 * SAM.gov document refresh and meeting-recording transcription. The edge functions apply the same
 * rules server-side (supabase/functions/_shared/proposal-sources.ts).
 */

export interface SourceSelection {
  /** False until the lists have loaded — callers then send nothing and the server defaults apply. */
  loaded: boolean;
  fileIds: string[];
  projectIds: string[];
}

/** Request fields for proposal-ai-generate / contract-ai-generate from a picker selection. */
export function selectionToPayload(sel: SourceSelection): Record<string, unknown> {
  if (!sel.loaded) return {};
  return {
    include_attached_documents: false,
    file_ids: sel.fileIds,
    include_project: false,
    project_ids: sel.projectIds,
  };
}

export type DocOrigin = 'opportunity' | 'contact' | 'project' | 'selected';

export interface DocumentTextInfo {
  status: 'extracted' | 'no_text' | 'unsupported' | 'too_large' | 'failed';
  char_count: number;
  page_count: number | null;
  error: string | null;
}

export interface SourceDocument {
  file: DriveFile;
  origins: DocOrigin[];
  isSolicitation: boolean;
  text: DocumentTextInfo | null;
  /** Projects whose project_files include this file. */
  projectIds: string[];
}

export interface SourceProject {
  id: string;
  name: string;
  status: string | null;
  link: 'opportunity' | 'proposal' | 'contact';
}

/** Projects linked to the deal (opportunity / proposal) or only to the client (contact). */
export async function getSourceProjects(args: {
  opportunityId?: string | null;
  proposalId?: string | null;
  contactId?: string | null;
}): Promise<SourceProject[]> {
  const out = new Map<string, SourceProject>();
  const run = async (col: 'opportunity_id' | 'proposal_id' | 'contact_id', val: string | null | undefined, link: SourceProject['link']) => {
    if (!val) return;
    const { data, error } = await supabase.from('projects').select('id, name, status').eq(col, val).limit(50);
    if (error) throw error;
    for (const p of (data ?? []) as { id: string; name: string; status: string | null }[]) {
      if (!out.has(p.id)) out.set(p.id, { ...p, link });
    }
  };
  await run('opportunity_id', args.opportunityId, 'opportunity');
  await run('proposal_id', args.proposalId, 'proposal');
  await run('contact_id', args.contactId, 'contact');
  return [...out.values()];
}

async function loadTexts(ids: string[]): Promise<Map<string, DocumentTextInfo>> {
  if (ids.length === 0) return new Map();
  const { data } = await supabase
    .from('document_texts')
    .select('drive_file_id, status, char_count, page_count, error')
    .in('drive_file_id', ids);
  return new Map(((data ?? []) as (DocumentTextInfo & { drive_file_id: string })[]).map((r) => [r.drive_file_id, r]));
}

/** Documents attached to the opportunity, the contact and the given projects (not deleted). */
export async function getSourceDocuments(args: {
  opportunityId?: string | null;
  contactId?: string | null;
  projectIds?: string[];
}): Promise<SourceDocument[]> {
  const origins = new Map<string, Set<DocOrigin>>();
  const byProject = new Map<string, string[]>();
  const mark = (id: string | null, o: DocOrigin) => {
    if (!id) return;
    if (!origins.has(id)) origins.set(id, new Set());
    origins.get(id)!.add(o);
  };
  if (args.opportunityId) {
    const { data } = await supabase.from('file_attachments').select('drive_file_id')
      .eq('entity_type', 'opportunities').eq('entity_id', args.opportunityId);
    for (const r of data ?? []) mark(r.drive_file_id as string, 'opportunity');
  }
  if (args.contactId) {
    const { data } = await supabase.from('file_attachments').select('drive_file_id')
      .eq('entity_type', 'contacts').eq('entity_id', args.contactId);
    for (const r of data ?? []) mark(r.drive_file_id as string, 'contact');
  }
  if (args.projectIds?.length) {
    const { data } = await supabase.from('project_files').select('drive_file_id, project_id').in('project_id', args.projectIds);
    for (const r of data ?? []) {
      const fid = r.drive_file_id as string | null;
      mark(fid, 'project');
      if (fid) byProject.set(fid, [...(byProject.get(fid) ?? []), r.project_id as string]);
    }
  }
  const ids = [...origins.keys()];
  if (ids.length === 0) return [];
  const [{ data: files, error }, texts] = await Promise.all([
    supabase.from('drive_files').select('*').in('id', ids).eq('is_deleted', false),
    loadTexts(ids),
  ]);
  if (error) throw error;
  return ((files ?? []) as DriveFile[])
    .map((file) => ({
      file,
      origins: [...(origins.get(file.id) ?? [])],
      isSolicitation: file.provider === 'sam_gov',
      text: texts.get(file.id) ?? null,
      projectIds: byProject.get(file.id) ?? [],
    }))
    // Solicitation documents first, then by name.
    .sort((a, b) => Number(b.isSolicitation) - Number(a.isSolicitation) || a.file.name.localeCompare(b.file.name));
}

/** File Manager (cached Drive / SharePoint / SAM files) name search for "add a document". */
export async function searchFileManagerFiles(query: string): Promise<SourceDocument[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const { data, error } = await supabase
    .from('drive_files')
    .select('*')
    .eq('is_deleted', false)
    .ilike('name', `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`)
    .neq('mime_type', 'application/vnd.google-apps.folder')
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  const files = (data ?? []) as DriveFile[];
  const texts = await loadTexts(files.map((f) => f.id));
  return files.map((file) => ({
    file, origins: ['selected'], isSolicitation: file.provider === 'sam_gov', text: texts.get(file.id) ?? null, projectIds: [],
  }));
}

export interface SamDocumentsSummary {
  total: number;
  stored: number;
  unchanged: number;
  failed: number;
  pending: number;
  no_text: number;
  items: { name?: string; status: string; text_status?: string; error?: string }[];
}

/** Re-download a SAM.gov opportunity's solicitation documents (refetch = pull amendments). */
export async function refreshSamDocuments(opportunityId: string, opts: { refetch?: boolean; force?: boolean } = {}): Promise<SamDocumentsSummary> {
  const res = await callEdgeFunction('sam-gov-api', { action: 'refresh-documents', opportunityId, ...opts });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || 'Refresh failed');
  }
  return data.data as SamDocumentsSummary;
}

/** Short-lived download link for a document the OS stores itself (SAM.gov files). */
export async function getStoredDocumentUrl(file: Pick<DriveFile, 'storage_path'>): Promise<string | null> {
  if (!file.storage_path) return null;
  const { data, error } = await supabase.storage.from('source-documents').createSignedUrl(file.storage_path, 300);
  if (error) throw error;
  return data?.signedUrl ?? null;
}

export function describeDocumentText(t: DocumentTextInfo | null): { label: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!t) return { label: 'Read at generation', tone: 'muted' };
  switch (t.status) {
    case 'extracted':
      return { label: `${t.char_count.toLocaleString()} chars${t.page_count ? ` · ${t.page_count} pp` : ''}`, tone: 'ok' };
    case 'no_text':
      return { label: 'Scanned — no text layer', tone: 'warn' };
    case 'unsupported':
      return { label: 'Unsupported type', tone: 'warn' };
    case 'too_large':
      return { label: 'Too large to read', tone: 'warn' };
    default:
      return { label: 'Read failed — retried at generation', tone: 'warn' };
  }
}

// ---------------------------------------------------------------------------
// Meeting recordings → transcript
// ---------------------------------------------------------------------------

export async function getTranscriptionConfig(): Promise<{ configured: boolean }> {
  const res = await callEdgeFunction('meeting-recording-transcribe', { action: 'status' });
  const data = await res.json().catch(() => ({}));
  return { configured: !!data.configured };
}

export async function startRecordingTranscription(
  meetingId: string,
  consent?: { basis: string; note?: string },
): Promise<{ status: string; error?: string; code?: string }> {
  const res = await callEdgeFunction('meeting-recording-transcribe', {
    meeting_transcription_id: meetingId,
    ...(consent ? { consent_basis: consent.basis, consent_note: consent.note } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) throw new Error(data.error || `Transcription failed (${res.status})`);
  return { status: data.status ?? 'queued', error: data.error, code: data.code };
}

export async function getMeetingTranscriptionState(meetingId: string): Promise<Pick<MeetingTranscription,
  'id' | 'transcript_text' | 'transcription_status' | 'transcription_error' | 'transcript_source'> | null> {
  const { data } = await supabase
    .from('meeting_transcriptions')
    .select('id, transcript_text, transcription_status, transcription_error, transcript_source')
    .eq('id', meetingId)
    .maybeSingle();
  return data;
}

/** A meeting with a recording but no transcript can be transcribed. */
export function canTranscribe(m: Pick<MeetingTranscription, 'recording_url' | 'recording_file_id' | 'transcript_text'>): boolean {
  return !m.transcript_text?.trim() && !!(m.recording_file_id || m.recording_url);
}

/** Sources the generator reported back (proposal-ai-generate / contract-ai-generate). */
export interface SourcesUsed {
  meetings?: { id: string; title?: string; summary?: boolean; ai_notes?: boolean; transcript?: boolean }[] | string[];
  documents: { id: string; name: string; origin: string; chars: number; truncated: boolean }[];
  omitted_documents: { id: string; name: string; origin: string; reason: string }[];
  projects: { id: string; name: string }[];
}
