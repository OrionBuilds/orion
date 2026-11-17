import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { Brain, Clock, FileText, Loader2, Network, Search, Sparkles, X } from 'lucide-react';
import MemoryGalaxy from '../../components/memory/MemoryGalaxy';
import VaultGraph3D from '../../components/memory/VaultGraph3D';
import {
  getRecentVaultNotes,
  getVaultGraph,
  getVaultNote,
  getVaultSyncStatus,
  searchVault,
  type VaultGraph,
  type VaultName,
  type VaultNote,
  type VaultNoteSummary,
  type VaultSearchHit,
  type VaultSyncStatus,
} from '../../services/vault';
import { resolveWikilink, wikilinksToMarkdown } from '../../utils/wikilinks';

type View = 'galaxy' | 'graph' | 'search' | 'recent';

const VAULTS: { id: VaultName; label: string }[] = [
  { id: 'friday', label: 'FRIDAY' },
  { id: 'clara', label: 'CLARA' },
  { id: 'harvey', label: 'HARVEY' },
];

const VIEWS: { id: View; label: string; icon: typeof Sparkles }[] = [
  { id: 'galaxy', label: 'Galaxy', icon: Sparkles },
  { id: 'graph', label: 'Graph', icon: Network },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'recent', label: 'Recent', icon: Clock },
];

const pill = (active: boolean) =>
  `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
    active ? 'bg-hud-gold text-hud-bg-deep' : 'bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white'
  }`;

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return 'unknown';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

/** ts_headline marks hits with « »; show them highlighted without rendering any HTML. */
function Preview({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <p className="text-xs text-hud-cream-dim mt-1 line-clamp-2">
      {parts.map((p, i) => (p.startsWith('«') ? <mark key={i} className="bg-hud-gold/30 text-white rounded px-0.5">{p.slice(1, -1)}</mark> : p))}
    </p>
  );
}

// Memory: the FRIDAY / CLARA Obsidian vaults (synced from the owner's Linux box), as the Memory
// Galaxy, the 3D knowledge graph, full-text search and recent notes. SuperAdmin-only.
export function Memory() {
  const [vault, setVault] = useState<VaultName>('friday');
  const [view, setView] = useState<View>('galaxy');
  const [status, setStatus] = useState<VaultSyncStatus[]>([]);
  const graphRef = useRef<VaultGraph | null>(null);

  const [open, setOpen] = useState<VaultNote | null>(null);
  const [opening, setOpening] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<VaultSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<VaultNoteSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    getVaultSyncStatus().then(setStatus).catch(() => setStatus([]));
  }, []);

  // Switching vaults resets everything that belongs to the previous one.
  useEffect(() => {
    graphRef.current = null;
    setOpen(null);
    setHits(null);
    setRecent(null);
    setListError(null);
  }, [vault]);

  const loadGraph = useCallback(async () => {
    const g = await getVaultGraph(vault);
    graphRef.current = g;
    return g;
  }, [vault]);

  const openNote = useCallback(async (path: string) => {
    setOpening(true);
    setNoteError(null);
    try {
      const note = await getVaultNote(vault, path);
      if (!note) setNoteError('That note is no longer in the vault.');
      setOpen(note);
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : 'Could not open the note');
    } finally {
      setOpening(false);
    }
  }, [vault]);

  const openWikilink = useCallback(async (target: string) => {
    const nodes = (graphRef.current ?? (await loadGraph())).nodes;
    const path = resolveWikilink(target, nodes);
    if (path) await openNote(path);
    else setNoteError(`"${target}" isn't a note in this vault yet.`);
  }, [loadGraph, openNote]);

  // Search, debounced.
  useEffect(() => {
    if (view !== 'search') return;
    const q = query.trim();
    if (!q) { setHits(null); return; }
    setSearching(true);
    const t = setTimeout(() => {
      searchVault(q, vault)
        .then((r) => { setHits(r); setListError(null); })
        .catch((e) => setListError(e instanceof Error ? e.message : 'Search failed'))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query, vault, view]);

  useEffect(() => {
    if (view !== 'recent' || recent) return;
    getRecentVaultNotes(vault)
      .then((r) => { setRecent(r); setListError(null); })
      .catch((e) => setListError(e instanceof Error ? e.message : 'Could not load recent notes'));
  }, [view, vault, recent]);

  const vaultStatus = status.find((s) => s.vault === vault) ?? null;
  const markdown = useMemo(() => (open ? wikilinksToMarkdown(open.content) : ''), [open]);

  const noteList = (items: (VaultNoteSummary & { preview?: string })[]) => (
    <div className="space-y-2">
      {items.map((n) => (
        <button
          key={n.path}
          onClick={() => openNote(n.path)}
          className={`w-full text-left p-3 rounded-lg border transition-colors ${
            open?.path === n.path ? 'border-hud-gold bg-hud-gold/10' : 'border-hud-bg-elev bg-hud-bg-card/50 hover:border-hud-cream-mute'
          }`}
        >
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-hud-gold-soft shrink-0" />
            <span className="text-sm text-white truncate">{n.title}</span>
            <span className="ml-auto text-[11px] text-hud-cream-mute shrink-0">{ago(n.mtime)}</span>
          </div>
          <p className="text-[11px] text-hud-cream-mute mt-0.5 truncate">{n.path}</p>
          {n.preview && <Preview text={n.preview} />}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem-var(--safe-top)-var(--bottom-nav))]">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gradient-to-br from-hud-gold/10 to-hud-teal/10 border border-hud-gold/20">
            <Brain className="w-6 h-6 text-hud-gold-soft" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-white">Memory</h1>
            <p className="text-sm text-hud-cream-dim mt-0.5">
              {vaultStatus
                ? `${vaultStatus.note_count.toLocaleString()} notes · ${vaultStatus.link_count.toLocaleString()} links · synced ${ago(vaultStatus.last_synced_at)}`
                : 'Waiting for FRIDAY to sync this vault from the Linux box'}
              {vaultStatus?.last_error && <span className="text-hud-rust"> · last sync failed: {vaultStatus.last_error}</span>}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-hud-bg-card border border-hud-bg-elev rounded-lg p-1">
            {VAULTS.map((v) => (
              <button key={v.id} onClick={() => setVault(v.id)}
                className={`px-3 py-1 rounded text-xs font-semibold tracking-wide transition-colors ${vault === v.id ? 'bg-hud-gold-deep text-white' : 'text-hud-cream-dim hover:text-white'}`}>
                {v.label}
              </button>
            ))}
          </div>
          {VIEWS.map((v) => {
            const Icon = v.icon;
            return (
              <button key={v.id} onClick={() => setView(v.id)} className={pill(view === v.id)}>
                <Icon className="w-4 h-4" />
                {v.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className={`flex-1 min-h-0 grid gap-4 ${open || opening || noteError ? 'lg:grid-cols-[minmax(0,1fr)_420px]' : 'grid-cols-1'}`}>
        <div className="relative min-h-[420px] bg-hud-bg-mid rounded-xl border border-hud-bg-card overflow-hidden">
          {view === 'galaxy' && <MemoryGalaxy key={`galaxy-${vault}`} loadGraph={loadGraph} onOpenNote={openNote} />}
          {view === 'graph' && <VaultGraph3D key={`graph-${vault}`} loadGraph={loadGraph} onOpenNote={openNote} />}
          {(view === 'search' || view === 'recent') && (
            <div className="absolute inset-0 overflow-y-auto p-4">
              {view === 'search' && (
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search the ${vault === 'friday' ? 'FRIDAY' : 'CLARA'} vault…`}
                    className="w-full pl-9 pr-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white placeholder:text-hud-cream-dim focus:outline-none focus:border-hud-gold"
                  />
                  {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute animate-spin" />}
                </div>
              )}
              {listError && <p className="text-sm text-hud-rust mb-3">{listError}</p>}
              {view === 'search' && hits && (hits.length ? noteList(hits) : <p className="text-sm text-hud-cream-dim">No notes match.</p>)}
              {view === 'search' && !hits && !searching && <p className="text-sm text-hud-cream-mute">Search titles and note text. Quotes, OR and -exclude work.</p>}
              {view === 'recent' && !recent && !listError && <Loader2 className="w-5 h-5 text-hud-cream-mute animate-spin" />}
              {view === 'recent' && recent && (recent.length ? noteList(recent) : <p className="text-sm text-hud-cream-dim">No notes synced yet.</p>)}
            </div>
          )}
        </div>

        {(open || opening || noteError) && (
          <aside className="min-h-0 flex flex-col bg-hud-bg-mid rounded-xl border border-hud-bg-card overflow-hidden">
            <div className="flex items-start gap-3 p-4 border-b border-hud-bg-card">
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-white truncate">{open?.title ?? (opening ? 'Opening…' : 'Note')}</h2>
                {open && <p className="text-[11px] text-hud-cream-mute truncate mt-0.5">{open.path} · edited {ago(open.mtime)}</p>}
              </div>
              <button onClick={() => { setOpen(null); setNoteError(null); }} className="p-1 rounded text-hud-cream-dim hover:text-white hover:bg-hud-bg-card" aria-label="Close note">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {noteError && <p className="text-sm text-hud-rust mb-3">{noteError}</p>}
              {opening && <Loader2 className="w-5 h-5 text-hud-cream-mute animate-spin" />}
              {open && !opening && (
                <div className="text-sm text-hud-cream-soft leading-relaxed space-y-3 break-words [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-white [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-white [&_h3]:font-semibold [&_h3]:text-white [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:bg-hud-bg-card [&_code]:px-1 [&_code]:rounded [&_pre]:bg-hud-bg-card [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_blockquote]:border-l-2 [&_blockquote]:border-hud-gold/50 [&_blockquote]:pl-3 [&_blockquote]:text-hud-cream-dim [&_hr]:border-hud-bg-elev">
                  <ReactMarkdown
                    urlTransform={(url) => (url.startsWith('wikilink:') ? url : defaultUrlTransform(url))}
                    components={{
                      a: ({ href, children }) =>
                        href?.startsWith('wikilink:') ? (
                          <button type="button" onClick={() => openWikilink(decodeURIComponent(href.slice('wikilink:'.length)))}
                            className="text-hud-gold-soft hover:underline">
                            {children}
                          </button>
                        ) : (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="text-hud-teal hover:underline">{children}</a>
                        ),
                    }}
                  >
                    {markdown}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
