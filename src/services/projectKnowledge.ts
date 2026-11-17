/**
 * Project knowledge notes (what FRIDAY knows about a project's code). Owner/SuperAdmin only: the
 * database enforces it (RLS), this just avoids showing a tab that would be empty. A human edit
 * freezes the note (source=human, auto_update=false, set by a trigger) so FRIDAY never overwrites it.
 */
import { supabase } from '../lib/supabase';

export interface KnowledgeNote {
  id: string;
  project_id: string;
  repo_url: string;
  kind: 'overview' | 'module' | 'concern';
  slug: string;
  title: string;
  summary: string;
  body: string;
  covers: string[];
  depends_on: string[];
  last_synced_commit: string | null;
  last_synced_at: string | null;
  stale: boolean;
  stale_reason: string | null;
  auto_update: boolean;
  source: 'agent' | 'human';
  version: number;
  updated_at: string;
}

export interface KnowledgeSync {
  repo_url: string;
  last_synced_commit: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  lock_until: string | null;
  uncovered_files: string[];
}

const KIND_ORDER: Record<string, number> = { overview: 0, module: 1, concern: 2 };

export async function canViewProjectKnowledge(userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_org_owner_or_superadmin', { p_user: userId });
  return !error && data === true;
}

export async function listKnowledge(projectId: string): Promise<{ notes: KnowledgeNote[]; sync: KnowledgeSync[] }> {
  const [notes, sync] = await Promise.all([
    supabase.from('project_knowledge').select('*').eq('project_id', projectId).limit(500),
    supabase
      .from('project_knowledge_sync')
      .select('repo_url,last_synced_commit,last_run_at,last_status,last_error,lock_until,uncovered_files')
      .eq('project_id', projectId),
  ]);
  if (notes.error) throw notes.error;
  if (sync.error) throw sync.error;
  const sorted = ((notes.data ?? []) as KnowledgeNote[]).sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.slug.localeCompare(b.slug),
  );
  return { notes: sorted, sync: (sync.data ?? []) as KnowledgeSync[] };
}

export interface NoteEdit {
  title: string;
  summary: string;
  body: string;
  covers: string[];
}

/** Save a human edit (title/summary/body/covers). The trigger marks it source=human + frozen. */
export async function saveKnowledgeNote(id: string, edit: NoteEdit): Promise<void> {
  const { error } = await supabase.from('project_knowledge').update(edit).eq('id', id);
  if (error) throw error;
}

export async function setKnowledgeAutoUpdate(id: string, autoUpdate: boolean): Promise<void> {
  const { error } = await supabase.from('project_knowledge').update({ auto_update: autoUpdate }).eq('id', id);
  if (error) throw error;
}

/** Queue a refresh for FRIDAY. Idempotent: returns created=false while one is already queued. */
export async function requestKnowledgeRefresh(projectId: string, slugs?: string[]): Promise<{ id: string; created: boolean }> {
  const { data, error } = await supabase.rpc('project_knowledge_request_refresh', {
    p_project_id: projectId,
    p_repo_url: null,
    p_slugs: slugs ?? null,
  });
  if (error) throw error;
  return data as { id: string; created: boolean };
}

/** One glob per line -> trimmed, non-empty list. */
export function parseCovers(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}
