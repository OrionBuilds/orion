import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  Download,
  ExternalLink,
  FileText,
  FolderKanban,
  Landmark,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  AlertCircle,
} from 'lucide-react';
import {
  describeDocumentText,
  getSourceDocuments,
  getSourceProjects,
  getStoredDocumentUrl,
  refreshSamDocuments,
  searchFileManagerFiles,
  type SourceDocument,
  type SourceProject,
  type SourceSelection,
} from '../../services/proposalSources';
import { formatFileSize } from '../../utils/formatters';

interface Props {
  opportunityId?: string | null;
  contactId?: string | null;
  proposalId?: string | null;
  /** The opportunity came from SAM.gov — offer "Refresh SAM.gov documents". */
  isSamGov?: boolean;
  onChange: (sel: SourceSelection) => void;
}

const ORIGIN_LABEL: Record<string, string> = {
  opportunity: 'Opportunity',
  contact: 'Client',
  project: 'Project',
  selected: 'Added',
};

/**
 * Documents + projects the AI generators should read. Defaults: everything attached to the
 * opportunity and client, plus projects linked to the deal and their files; client-only projects
 * are offered unticked. Users can untick anything or add File Manager files by name.
 */
export function SourceDocumentsPicker({ opportunityId, contactId, proposalId, isSamGov, onChange }: Props) {
  const [projects, setProjects] = useState<SourceProject[]>([]);
  const [docs, setDocs] = useState<SourceDocument[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [tickedProjects, setTickedProjects] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SourceDocument[]>([]);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const projs = await getSourceProjects({ opportunityId, proposalId, contactId });
      const docsList = await getSourceDocuments({ opportunityId, contactId, projectIds: projs.map((p) => p.id) });
      const autoProjects = new Set(projs.filter((p) => p.link !== 'contact').map((p) => p.id));
      setProjects(projs);
      setTickedProjects((prev) => (loaded ? prev : autoProjects));
      setDocs((prev) => {
        // Keep manually added files across reloads.
        const extra = prev.filter((d) => d.origins.includes('selected') && !docsList.some((x) => x.file.id === d.file.id));
        return [...docsList, ...extra];
      });
      setTicked((prev) => {
        if (loaded) {
          const next = new Set(prev);
          // Newly appeared documents (e.g. after a SAM refresh) default to ticked.
          for (const d of docsList) if (!prev.has(d.file.id) && d.isSolicitation) next.add(d.file.id);
          return next;
        }
        return new Set(docsList
          .filter((d) => d.origins.some((o) => o === 'opportunity' || o === 'contact') ||
            d.projectIds.some((pid) => autoProjects.has(pid)))
          .map((d) => d.file.id));
      });
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load attached documents');
    }
  }, [opportunityId, contactId, proposalId, loaded]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opportunityId, contactId, proposalId]);

  // Ticking a project also ticks its files; unticking hides files that only belong to it.
  const toggleProject = (id: string) => {
    const on = !tickedProjects.has(id);
    setTickedProjects((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
    if (on) {
      setTicked((prev) => {
        const next = new Set(prev);
        for (const d of docs) if (d.projectIds.includes(id)) next.add(d.file.id);
        return next;
      });
    }
  };

  const visibleDocs = useMemo(() => docs.filter((d) =>
    d.origins.some((o) => o !== 'project') || d.projectIds.some((pid) => tickedProjects.has(pid))),
  [docs, tickedProjects]);

  useEffect(() => {
    onChange({
      loaded,
      fileIds: [...ticked].filter((id) => visibleDocs.some((d) => d.file.id === id)),
      projectIds: [...tickedProjects],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, ticked, tickedProjects, visibleDocs]);

  const toggleDoc = (id: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setSearching(false); return; }
    let active = true;
    setSearching(true);
    const t = setTimeout(() => {
      searchFileManagerFiles(query)
        .then((r) => { if (active) setResults(r.filter((x) => !docs.some((d) => d.file.id === x.file.id))); })
        .catch(() => { if (active) setResults([]); })
        .finally(() => { if (active) setSearching(false); });
    }, 300);
    return () => { active = false; clearTimeout(t); };
  }, [query, docs]);

  const addDoc = (d: SourceDocument) => {
    setDocs((prev) => [...prev, { ...d, origins: ['selected'] }]);
    setTicked((prev) => new Set(prev).add(d.file.id));
    setQuery('');
    setResults([]);
  };

  const handleRefresh = async (refetch: boolean) => {
    if (!opportunityId) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const s = await refreshSamDocuments(opportunityId, { refetch });
      const parts = [`${s.stored + s.unchanged} of ${s.total} stored`];
      if (s.failed) parts.push(`${s.failed} failed`);
      if (s.pending) parts.push(`${s.pending} still pending — refresh again`);
      if (s.no_text) parts.push(`${s.no_text} scanned (no text)`);
      setRefreshMsg(s.total === 0 ? 'SAM.gov lists no documents for this notice.' : parts.join(' · '));
      await load();
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const openDoc = async (d: SourceDocument) => {
    try {
      const url = d.file.storage_path ? await getStoredDocumentUrl(d.file) : d.file.web_view_link;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open document');
    }
  };

  const tickedCount = visibleDocs.filter((d) => ticked.has(d.file.id)).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-hud-cream-soft uppercase tracking-wider flex items-center gap-2">
          <Paperclip className="w-4 h-4" />
          Attached Documents
          {loaded && <span className="text-xs normal-case text-hud-cream-mute">({tickedCount} selected)</span>}
        </h3>
        {isSamGov && opportunityId && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleRefresh(false)}
              disabled={refreshing}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-hud-bg-card border border-hud-bg-elev text-hud-cream-soft hover:text-white disabled:opacity-50"
              title="Download any SAM.gov documents that are missing"
            >
              {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Refresh SAM.gov documents
            </button>
            <button
              type="button"
              onClick={() => handleRefresh(true)}
              disabled={refreshing}
              className="px-2 py-1 text-xs rounded-md text-hud-cream-mute hover:text-hud-cream-soft disabled:opacity-50"
              title="Re-pull the notice from SAM.gov to pick up amendments (uses one SAM.gov API call)"
            >
              + amendments
            </button>
          </div>
        )}
      </div>
      <p className="text-xs text-hud-cream-mute">
        Files attached to the opportunity, client and linked projects. Text is extracted server-side
        (PDF, Word, Excel, PowerPoint, text); Google Drive and SharePoint files are read through your connected account.
      </p>
      {refreshMsg && <p className="text-xs text-hud-cream-dim">{refreshMsg}</p>}
      {error && (
        <p className="text-xs text-hud-plum flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {error}
        </p>
      )}

      {!loaded && !error ? (
        <p className="text-xs text-hud-cream-mute flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading documents…</p>
      ) : visibleDocs.length === 0 ? (
        <div className="text-center py-4 bg-hud-bg-card/40 rounded-lg border border-hud-bg-elev/50">
          <p className="text-sm text-hud-cream-dim">No documents attached yet.</p>
          <p className="text-xs text-hud-cream-mute mt-0.5">Attach files on the opportunity or contact, or add one from the File Manager below.</p>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
          {visibleDocs.map((d) => {
            const on = ticked.has(d.file.id);
            const t = describeDocumentText(d.text);
            return (
              <div
                key={d.file.id}
                className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors ${
                  on ? 'border-hud-gold/60 bg-hud-gold/10' : 'border-hud-bg-elev bg-hud-bg-card/50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleDoc(d.file.id)}
                  aria-pressed={on}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                >
                  <span className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${on ? 'bg-hud-gold border-hud-gold' : 'border-hud-cream-mute'}`}>
                    {on && <CheckCircle className="w-3 h-3 text-white" />}
                  </span>
                  {d.isSolicitation ? (
                    <Landmark className="w-4 h-4 text-hud-gold-soft flex-shrink-0" />
                  ) : (
                    <FileText className="w-4 h-4 text-hud-cream-dim flex-shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-white truncate" title={d.file.name}>{d.file.name}</span>
                    <span className="flex flex-wrap items-center gap-2 text-[11px] text-hud-cream-mute">
                      {d.isSolicitation && (
                        <span className="px-1.5 py-0.5 rounded bg-hud-gold/15 text-hud-gold-soft border border-hud-gold/25">SAM.gov solicitation</span>
                      )}
                      {d.origins.map((o) => <span key={o}>{ORIGIN_LABEL[o] ?? o}</span>)}
                      {d.file.size_bytes > 0 && <span>{formatFileSize(d.file.size_bytes)}</span>}
                      <span className={t.tone === 'ok' ? 'text-hud-emerald' : t.tone === 'warn' ? 'text-hud-rust' : ''}>{t.label}</span>
                    </span>
                  </span>
                </button>
                {(d.file.storage_path || d.file.web_view_link) && (
                  <button
                    type="button"
                    onClick={() => openDoc(d)}
                    className="p-1.5 rounded text-hud-cream-mute hover:text-white"
                    title={d.file.storage_path ? 'Download' : 'Open'}
                  >
                    {d.file.storage_path ? <Download className="w-3.5 h-3.5" /> : <ExternalLink className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-hud-cream-mute" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Add a File Manager document by name…"
          className="w-full pl-8 pr-8 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
        />
        {searching && <Loader2 className="w-3.5 h-3.5 animate-spin absolute right-3 top-1/2 -translate-y-1/2 text-hud-cream-mute" />}
        {results.length > 0 && (
          <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-hud-bg-elev bg-hud-bg-mid shadow-lg">
            {results.map((r) => (
              <button
                type="button"
                key={r.file.id}
                onClick={() => addDoc(r)}
                className="w-full text-left px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-card flex items-center gap-2"
              >
                <FileText className="w-3.5 h-3.5 text-hud-cream-mute flex-shrink-0" />
                <span className="truncate">{r.file.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {projects.length > 0 && (
        <div className="space-y-1.5 pt-2">
          <h3 className="text-sm font-medium text-hud-cream-soft uppercase tracking-wider flex items-center gap-2">
            <FolderKanban className="w-4 h-4" />
            Project Context
          </h3>
          <p className="text-xs text-hud-cream-mute">
            A summary of tasks, change requests, support tickets and notes is included for each ticked project.
          </p>
          {projects.map((p) => {
            const on = tickedProjects.has(p.id);
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => toggleProject(p.id)}
                aria-pressed={on}
                className={`w-full flex items-center gap-3 p-2.5 rounded-lg border text-left transition-colors ${
                  on ? 'border-hud-gold/60 bg-hud-gold/10' : 'border-hud-bg-elev bg-hud-bg-card/50'
                }`}
              >
                <span className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${on ? 'bg-hud-gold border-hud-gold' : 'border-hud-cream-mute'}`}>
                  {on && <CheckCircle className="w-3 h-3 text-white" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-white truncate">{p.name}</span>
                  <span className="text-[11px] text-hud-cream-mute">
                    {p.link === 'contact' ? 'Linked to this client' : p.link === 'proposal' ? 'Linked to this proposal' : 'Linked to this opportunity'}
                    {p.status ? ` · ${p.status}` : ''}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
