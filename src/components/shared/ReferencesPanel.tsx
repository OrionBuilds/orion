import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Loader2, MessageSquare, StickyNote, FileText, ClipboardList } from 'lucide-react';
import { getBacklinks, type Backlink, type MentionSourceType } from '../../services/entityMentions';
import { supabase } from '../../lib/supabase';
import type { MentionTargetType } from '../../utils/mentionTokens';

const SOURCE_ICON: Record<MentionSourceType, typeof MessageSquare> = {
  team_message: MessageSquare,
  conversation_message: MessageSquare,
  contact_note: StickyNote,
  project_note: StickyNote,
  opportunity_note: StickyNote,
  document: FileText,
  contact_task: ClipboardList,
  project_task: ClipboardList,
};

const SOURCE_LABEL: Record<MentionSourceType, string> = {
  team_message: 'Team chat',
  conversation_message: 'Internal comment',
  contact_note: 'Contact note',
  project_note: 'Project note',
  opportunity_note: 'Opportunity note',
  document: 'Document',
  contact_task: 'Contact task',
  project_task: 'Project task',
};

// Best-effort deep link back to the record that CONTAINS the mention
// (not the mentioned entity itself — that's the page we're already on).
// entity_mentions only stores the note/message id, not its parent, so this
// resolves the parent via one small lookup per distinct source table
// (batched in resolveSourceHrefs below) rather than storing a redundant
// denormalized column on entity_mentions.
async function resolveSourceHrefs(mentions: Backlink[]): Promise<Map<string, string>> {
  const hrefs = new Map<string, string>();

  const contactNoteIds = mentions.filter((m) => m.source_type === 'contact_note').map((m) => m.source_id);
  const projectNoteIds = mentions.filter((m) => m.source_type === 'project_note').map((m) => m.source_id);
  const opportunityNoteIds = mentions.filter((m) => m.source_type === 'opportunity_note').map((m) => m.source_id);
  const conversationMessageIds = mentions.filter((m) => m.source_type === 'conversation_message').map((m) => m.source_id);
  const hasTeamMessage = mentions.some((m) => m.source_type === 'team_message');

  await Promise.all([
    (async () => {
      if (contactNoteIds.length === 0) return;
      const { data } = await supabase.from('contact_notes').select('id, contact_id').in('id', contactNoteIds);
      for (const row of data || []) hrefs.set(`contact_note:${row.id}`, `/contacts/${row.contact_id}`);
    })(),
    (async () => {
      if (projectNoteIds.length === 0) return;
      const { data } = await supabase.from('project_notes').select('id, project_id').in('id', projectNoteIds);
      for (const row of data || []) hrefs.set(`project_note:${row.id}`, `/projects/${row.project_id}`);
    })(),
    (async () => {
      if (opportunityNoteIds.length === 0) return;
      const { data } = await supabase.from('opportunity_notes').select('id, opportunity_id').in('id', opportunityNoteIds);
      for (const row of data || []) hrefs.set(`opportunity_note:${row.id}`, `/opportunities/${row.opportunity_id}`);
    })(),
    (async () => {
      if (conversationMessageIds.length === 0) return;
      const { data } = await supabase.from('messages').select('id, conversation_id').in('id', conversationMessageIds);
      for (const row of data || []) hrefs.set(`conversation_message:${row.id}`, `/conversations/${row.conversation_id}`);
    })(),
  ]);

  // Team chat has no per-message deep link (channel selection is client
  // state, not URL-addressable) — route to the Team tab as the closest
  // real destination.
  if (hasTeamMessage) hrefs.set('__team_message__', '/conversations?tab=team-messaging');

  return hrefs;
}

function hrefFor(mention: Backlink, hrefs: Map<string, string>): string | null {
  if (mention.source_type === 'team_message') return hrefs.get('__team_message__') || null;
  // The Docs creator was removed, so a 'document' mention has nowhere to open.
  if (mention.source_type === 'document') return null;
  return hrefs.get(`${mention.source_type}:${mention.source_id}`) || null;
}

interface ReferencesPanelProps {
  targetType: MentionTargetType;
  targetId: string;
  /** Optional: collapse the panel by default when there are no backlinks yet is implicit; this only affects initial open state when there ARE results. */
  defaultOpen?: boolean;
}

/**
 * Shows everything that @mentions this entity — team chat messages, notes,
 * tasks, etc. — newest first, with a snippet of surrounding context.
 */
export function ReferencesPanel({ targetType, targetId, defaultOpen = true }: ReferencesPanelProps) {
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [hrefs, setHrefs] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(defaultOpen);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getBacklinks(targetType, targetId);
      setBacklinks(data);
      setHrefs(await resolveSourceHrefs(data));
    } catch (error) {
      console.error('Failed to load references:', error);
    } finally {
      setLoading(false);
    }
  }, [targetType, targetId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between p-4 text-left"
      >
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-hud-cream-mute" />
          <span className="text-sm font-medium text-white">References</span>
          {!loading && backlinks.length > 0 && (
            <span className="text-xs text-hud-cream-mute">({backlinks.length})</span>
          )}
        </div>
        {loading && <Loader2 className="w-3.5 h-3.5 text-hud-cream-mute animate-spin" />}
      </button>

      {open && (
        <div className="px-4 pb-4">
          {loading && backlinks.length === 0 ? (
            <div className="text-xs text-hud-cream-mute py-2">Loading…</div>
          ) : backlinks.length === 0 ? (
            <div className="text-xs text-hud-cream-mute py-2">
              Nothing mentions this yet. @mention it from team chat or a note to link it here.
            </div>
          ) : (
            <ul className="space-y-2">
              {backlinks.map((mention) => {
                const Icon = SOURCE_ICON[mention.source_type] || MessageSquare;
                const href = hrefFor(mention, hrefs);
                const content = (
                  <div className="flex items-start gap-2 p-2 rounded-lg hover:bg-hud-bg-card/60 transition-colors">
                    <Icon className="w-3.5 h-3.5 text-hud-cream-mute mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-hud-cream-mute">
                        <span>{SOURCE_LABEL[mention.source_type] || mention.source_type}</span>
                        {mention.created_by_user?.name && <span>· {mention.created_by_user.name}</span>}
                        <span>· {new Date(mention.created_at).toLocaleDateString()}</span>
                      </div>
                      {mention.snippet && (
                        <p className="text-sm text-hud-cream-soft mt-0.5 truncate">{mention.snippet}</p>
                      )}
                    </div>
                  </div>
                );
                return (
                  <li key={mention.id}>
                    {href ? (
                      <Link to={href}>{content}</Link>
                    ) : (
                      content
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
