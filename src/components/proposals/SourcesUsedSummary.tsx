import { FileText, FolderKanban, Landmark, Video, AlertCircle } from 'lucide-react';
import type { SourcesUsed } from '../../services/proposalSources';

const ORIGIN: Record<string, string> = {
  solicitation: 'SAM.gov solicitation',
  upload: 'Uploaded',
  selected: 'Added',
  opportunity: 'Opportunity',
  project: 'Project',
  contact: 'Client',
};

/** What the generator actually read, as reported by proposal-ai-generate / contract-ai-generate. */
export function SourcesUsedSummary({ sources }: { sources: SourcesUsed | null }) {
  if (!sources) return null;
  const meetings = (sources.meetings ?? []) as (string | { id: string; title?: string; summary?: boolean; ai_notes?: boolean; transcript?: boolean })[];
  const empty = meetings.length === 0 && sources.documents.length === 0 && sources.projects.length === 0;
  return (
    <div className="text-left bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev p-4 space-y-3">
      <h3 className="text-sm font-medium text-hud-cream-soft">Sources used</h3>
      {empty && <p className="text-xs text-hud-cream-mute">Only client and deal details were used.</p>}
      {meetings.length > 0 && (
        <div className="space-y-1">
          {meetings.map((m) => typeof m === 'string' ? (
            <p key={m} className="text-xs text-hud-cream-dim flex items-center gap-2"><Video className="w-3.5 h-3.5" /> Meeting</p>
          ) : (
            <p key={m.id} className="text-xs text-hud-cream-dim flex items-center gap-2">
              <Video className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="text-white truncate">{m.title || 'Meeting'}</span>
              <span>{[m.summary && 'summary', m.ai_notes && 'AI notes', m.transcript && 'transcript'].filter(Boolean).join(' · ') || 'no content'}</span>
            </p>
          ))}
        </div>
      )}
      {sources.documents.length > 0 && (
        <div className="space-y-1">
          {sources.documents.map((d) => (
            <p key={d.id} className="text-xs text-hud-cream-dim flex items-center gap-2">
              {d.origin === 'solicitation' ? <Landmark className="w-3.5 h-3.5 text-hud-gold-soft flex-shrink-0" /> : <FileText className="w-3.5 h-3.5 flex-shrink-0" />}
              <span className="text-white truncate">{d.name}</span>
              <span>{ORIGIN[d.origin] ?? d.origin} · {d.chars.toLocaleString()} chars{d.truncated ? ' (truncated)' : ''}</span>
            </p>
          ))}
        </div>
      )}
      {sources.omitted_documents.length > 0 && (
        <div className="space-y-1">
          {sources.omitted_documents.map((d) => (
            <p key={d.id} className="text-xs text-hud-rust flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">{d.name}</span>
              <span className="text-hud-cream-mute">not used — {d.reason}</span>
            </p>
          ))}
        </div>
      )}
      {sources.projects.length > 0 && (
        <div className="space-y-1">
          {sources.projects.map((p) => (
            <p key={p.id} className="text-xs text-hud-cream-dim flex items-center gap-2">
              <FolderKanban className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="text-white truncate">{p.name}</span>
              <span>project summary</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
