/**
 * Knowledge tab (owner/admin only): the notes FRIDAY keeps about this project's code, with stale
 * badges, a human editor (an edit freezes the note so FRIDAY won't overwrite it), the auto-update
 * toggle, files no note covers, and a Refresh button that queues the work for FRIDAY.
 */
import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Loader2, Pencil, RefreshCw, Snowflake } from 'lucide-react';
import { getErrorMessage } from '../../lib/errors';
import {
  listKnowledge,
  parseCovers,
  requestKnowledgeRefresh,
  saveKnowledgeNote,
  setKnowledgeAutoUpdate,
  type KnowledgeNote,
  type KnowledgeSync,
} from '../../services/projectKnowledge';

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never';
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ProjectKnowledgeTab({ projectId }: { projectId: string }) {
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [sync, setSync] = useState<KnowledgeSync[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ title: string; summary: string; body: string; covers: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await listKnowledge(projectId);
      setNotes(r.notes);
      setSync(r.sync);
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not load the project notes'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const open = notes.find((n) => n.id === openId) ?? null;
  const uncovered = sync.flatMap((s) => s.uncovered_files);

  const run = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      await load();
    } catch (e) {
      setError(getErrorMessage(e, 'That did not work'));
    } finally {
      setBusy(false);
    }
  };

  const refresh = () => run(async () => {
    const r = await requestKnowledgeRefresh(projectId);
    setMessage(r.created ? 'Refresh queued for FRIDAY.' : 'A refresh is already queued.');
  });

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-hud-gold" /></div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-hud-text-secondary">
          What FRIDAY knows about this project&apos;s code. Notes are reference data she reads before every run.
          {sync[0] ? ` Last sync ${timeAgo(sync[0].last_run_at)}${sync[0].last_status ? ` (${sync[0].last_status})` : ''}.` : ''}
        </div>
        <button
          onClick={refresh}
          disabled={busy}
          className="px-3 py-1.5 bg-hud-gold-deep text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {error && <div className="text-sm text-hud-rust">{error}</div>}
      {message && <div className="text-sm text-hud-emerald">{message}</div>}
      {sync.some((s) => s.last_error) && (
        <div className="text-xs text-hud-rust">Last sync error: {sync.find((s) => s.last_error)?.last_error}</div>
      )}

      {notes.length === 0 ? (
        <div className="text-center py-12 text-hud-text-secondary">
          <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No notes yet. Press Refresh and FRIDAY will read the repo and write them.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ul className="space-y-2 lg:col-span-1">
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => { setOpenId(n.id); setEditing(null); }}
                  className={`w-full text-left bg-hud-bg-card border rounded-lg px-3 py-2 ${openId === n.id ? 'border-hud-gold' : 'border-hud-bg-elev'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-white text-sm font-medium truncate">{n.title}</span>
                    {n.stale && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-hud-rust/20 text-hud-rust">stale</span>}
                    {!n.auto_update && <Snowflake className="w-3 h-3 text-hud-text-secondary" aria-label="Frozen" />}
                  </div>
                  <div className="text-xs text-hud-text-secondary line-clamp-2">{n.summary}</div>
                  <div className="text-[10px] text-hud-text-secondary mt-1 capitalize">
                    {n.kind} · {n.source} · v{n.version} · {timeAgo(n.updated_at)}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <div className="lg:col-span-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg p-4 min-h-[200px]">
            {!open ? (
              <p className="text-sm text-hud-text-secondary">Pick a note to read it.</p>
            ) : editing ? (
              <div className="space-y-3">
                <input
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  maxLength={200}
                  className="w-full bg-hud-bg border border-hud-bg-elev rounded px-3 py-2 text-white text-sm"
                />
                <input
                  value={editing.summary}
                  onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
                  maxLength={300}
                  placeholder="One-line summary (max 300 characters)"
                  className="w-full bg-hud-bg border border-hud-bg-elev rounded px-3 py-2 text-white text-sm"
                />
                <textarea
                  value={editing.covers}
                  onChange={(e) => setEditing({ ...editing, covers: e.target.value })}
                  rows={3}
                  placeholder="Files this covers, one glob per line (src/api/**)"
                  className="w-full bg-hud-bg border border-hud-bg-elev rounded px-3 py-2 text-white text-xs font-mono"
                />
                <textarea
                  value={editing.body}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                  rows={16}
                  className="w-full bg-hud-bg border border-hud-bg-elev rounded px-3 py-2 text-white text-sm font-mono"
                />
                <p className="text-xs text-hud-text-secondary">
                  Saving marks this note as yours and stops FRIDAY from rewriting it (switch auto-update back on to let her).
                  Keep keys and passwords out of notes.
                </p>
                <div className="flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() => run(async () => {
                      await saveKnowledgeNote(open.id, { ...editing, covers: parseCovers(editing.covers) });
                      setEditing(null);
                    }, 'Saved.')}
                    className="px-3 py-1.5 bg-hud-gold-deep text-white rounded-lg text-sm disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-hud-text-secondary">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-white font-medium">{open.title}</h3>
                    {open.repo_url && <div className="text-xs text-hud-text-secondary">{open.repo_url}</div>}
                    {open.stale && <div className="text-xs text-hud-rust mt-1">Stale{open.stale_reason ? `: ${open.stale_reason}` : ''}</div>}
                    {open.last_synced_commit && (
                      <div className="text-xs text-hud-text-secondary">Synced at {open.last_synced_commit.slice(0, 8)} · {timeAgo(open.last_synced_at)}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <label className="flex items-center gap-1.5 text-xs text-hud-text-secondary">
                      <input
                        type="checkbox"
                        checked={open.auto_update}
                        disabled={busy}
                        onChange={(e) => run(() => setKnowledgeAutoUpdate(open.id, e.target.checked))}
                      />
                      Auto-update
                    </label>
                    <button
                      onClick={() => setEditing({ title: open.title, summary: open.summary, body: open.body, covers: open.covers.join('\n') })}
                      className="px-2.5 py-1 border border-hud-bg-elev rounded text-xs text-white flex items-center gap-1"
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                  </div>
                </div>
                {open.covers.length > 0 && (
                  <div className="text-xs text-hud-text-secondary font-mono break-words">Covers: {open.covers.join('  ')}</div>
                )}
                <pre className="whitespace-pre-wrap text-sm text-white font-sans">{open.body}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {uncovered.length > 0 && (
        <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-4">
          <h4 className="text-sm text-white mb-2">Files no note covers ({uncovered.length})</h4>
          <div className="text-xs text-hud-text-secondary font-mono space-y-0.5 max-h-40 overflow-auto">
            {uncovered.slice(0, 100).map((f) => <div key={f}>{f}</div>)}
            {uncovered.length > 100 && <div>…and {uncovered.length - 100} more</div>}
          </div>
        </div>
      )}
    </div>
  );
}
