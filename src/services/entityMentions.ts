import { supabase } from '../lib/supabase';
import {
  parseMentions,
  buildMentionSnippet,
  type MentionTargetType,
} from '../utils/mentionTokens';

export type MentionSourceType =
  | 'team_message'
  | 'contact_note'
  | 'project_note'
  | 'opportunity_note'
  | 'document'
  | 'contact_task'
  | 'project_task'
  | 'conversation_message';

export interface EntityMention {
  id: string;
  org_id: string;
  source_type: MentionSourceType;
  source_id: string;
  target_type: MentionTargetType;
  target_id: string;
  snippet: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Backlink extends EntityMention {
  created_by_user?: { id: string; name: string; avatar_url: string | null } | null;
}

export interface SyncMentionsParams {
  orgId: string;
  sourceType: MentionSourceType;
  sourceId: string;
  text: string;
  createdBy: string | null;
}

/**
 * Diff-based upsert: parse `text` for @[Name](type:id) tokens, insert any
 * new (source, target) pairs, and delete rows for targets no longer present
 * in the text. Never throws by default (`opts.silent`, default true) — this
 * runs inline in message/note send paths and a mention-sync bug must never
 * block the underlying send/save.
 */
export async function syncMentionsForSource(
  params: SyncMentionsParams,
  opts: { silent?: boolean } = {}
): Promise<void> {
  const { orgId, sourceType, sourceId, text, createdBy } = params;
  const silent = opts.silent ?? true;

  try {
    const parsed = parseMentions(text);

    // De-dupe multiple mentions of the same target within one source,
    // keeping the first occurrence's snippet (matches the UNIQUE constraint).
    const byTarget = new Map<string, { target_type: MentionTargetType; target_id: string; snippet: string }>();
    for (const m of parsed) {
      const key = `${m.type}:${m.id}`;
      if (byTarget.has(key)) continue;
      byTarget.set(key, {
        target_type: m.type,
        target_id: m.id,
        snippet: buildMentionSnippet(text, m.index, m.raw.length),
      });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('entity_mentions')
      .select('id, target_type, target_id')
      .eq('source_type', sourceType)
      .eq('source_id', sourceId);

    if (fetchError) throw fetchError;

    const existingByKey = new Map(
      (existing || []).map((row) => [`${row.target_type}:${row.target_id}`, row.id])
    );

    const toDeleteIds = (existing || [])
      .filter((row) => !byTarget.has(`${row.target_type}:${row.target_id}`))
      .map((row) => row.id);

    const toInsert = Array.from(byTarget.entries())
      .filter(([key]) => !existingByKey.has(key))
      .map(([, v]) => ({
        org_id: orgId,
        source_type: sourceType,
        source_id: sourceId,
        target_type: v.target_type,
        target_id: v.target_id,
        snippet: v.snippet,
        created_by: createdBy,
      }));

    if (toDeleteIds.length > 0) {
      const { error } = await supabase.from('entity_mentions').delete().in('id', toDeleteIds);
      if (error) throw error;
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from('entity_mentions').insert(toInsert);
      if (error) throw error;
    }
  } catch (error) {
    if (!silent) throw error;
    console.error('syncMentionsForSource failed (non-fatal):', error);
  }
}

/** Remove all mention rows for a source (call when the source itself is hard-deleted). */
export async function deleteMentionsForSource(
  sourceType: MentionSourceType,
  sourceId: string
): Promise<void> {
  try {
    const { error } = await supabase
      .from('entity_mentions')
      .delete()
      .eq('source_type', sourceType)
      .eq('source_id', sourceId);
    if (error) throw error;
  } catch (error) {
    console.error('deleteMentionsForSource failed (non-fatal):', error);
  }
}

/** Backlinks: everything that mentions a given entity, newest first. */
export async function getBacklinks(
  targetType: MentionTargetType,
  targetId: string,
  limit = 50
): Promise<Backlink[]> {
  const { data, error } = await supabase
    .from('entity_mentions')
    .select('*, created_by_user:users!entity_mentions_created_by_fkey(id, name, avatar_url)')
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []) as Backlink[];
}

export interface MentionableEntity {
  type: MentionTargetType;
  id: string;
  displayName: string;
  subtitle?: string;
}

/**
 * Search across all mentionable entity types in parallel for the
 * EntityMentionDropdown. Each query is isolated with try/catch — one
 * failing table (e.g. `documents` before A4 ships) must not blank out the
 * other five result sets.
 */
export async function searchMentionableEntities(
  query: string,
  orgId: string,
  limit = 5,
  /** Only search these types (default: all), so a users-only picker isn't crowded out by other results. */
  types?: MentionTargetType[]
): Promise<MentionableEntity[]> {
  const q = query.trim();
  if (!q) return [];
  const wants = (t: MentionTargetType) => !types || types.includes(t);
  const term = `%${q}%`;

  const safeQuery = async (type: MentionTargetType, fn: () => Promise<MentionableEntity[]>): Promise<MentionableEntity[]> => {
    if (!wants(type)) return [];
    try {
      return await fn();
    } catch (error) {
      console.error('searchMentionableEntities: one source failed (non-fatal):', error);
      return [];
    }
  };

  const [contacts, opportunities, projects, proposals, users, documents] = await Promise.all([
    safeQuery('contact', async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, first_name, last_name, company')
        .eq('organization_id', orgId)
        .or(`first_name.ilike.${term},last_name.ilike.${term},company.ilike.${term}`)
        .limit(limit);
      if (error) throw error;
      return (data || []).map((c) => ({
        type: 'contact' as const,
        id: c.id,
        displayName: `${c.first_name} ${c.last_name || ''}`.trim(),
        subtitle: c.company || undefined,
      }));
    }),
    safeQuery('opportunity', async () => {
      const { data, error } = await supabase
        .from('opportunities')
        .select('id, name')
        .eq('org_id', orgId)
        .ilike('name', term)
        .limit(limit);
      if (error) throw error;
      return (data || []).map((o) => ({
        type: 'opportunity' as const,
        id: o.id,
        displayName: o.name,
        subtitle: 'Opportunity',
      }));
    }),
    safeQuery('project', async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('id, name')
        .eq('org_id', orgId)
        .ilike('name', term)
        .limit(limit);
      if (error) throw error;
      return (data || []).map((p) => ({
        type: 'project' as const,
        id: p.id,
        displayName: p.name,
        subtitle: 'Project',
      }));
    }),
    safeQuery('proposal', async () => {
      const { data, error } = await supabase
        .from('proposals')
        .select('id, title')
        .eq('org_id', orgId)
        .ilike('title', term)
        .limit(limit);
      if (error) throw error;
      return (data || []).map((p) => ({
        type: 'proposal' as const,
        id: p.id,
        displayName: p.title,
        subtitle: 'Proposal',
      }));
    }),
    safeQuery('user', async () => {
      const { data, error } = await supabase
        .from('users')
        .select('id, name, email')
        .eq('organization_id', orgId)
        .or(`name.ilike.${term},email.ilike.${term}`)
        .limit(limit);
      if (error) throw error;
      return (data || []).map((u) => ({
        type: 'user' as const,
        id: u.id,
        displayName: u.name,
        subtitle: u.email || undefined,
      }));
    }),
    // `documents` doesn't exist until A4 ships — resolves to [] until then
    // (safeQuery swallows the "relation does not exist" error).
    safeQuery('document', async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('id, title')
        .eq('org_id', orgId)
        .ilike('title', term)
        .limit(limit);
      if (error) throw error;
      return (data || []).map((d) => ({
        type: 'document' as const,
        id: d.id,
        displayName: d.title,
        subtitle: 'Document',
      }));
    }),
  ]);

  return [...contacts, ...opportunities, ...projects, ...proposals, ...users, ...documents];
}
