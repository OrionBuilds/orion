import { useEffect, useState } from 'react';
import { ClipboardCheck, CheckCircle2, Clock, ExternalLink, MessageSquare, PencilLine } from 'lucide-react';
import {
  portalListClientReviews,
  portalDecideClientReview,
  portalAddClientReviewComment,
  type PortalClientReview,
} from '../../services/clientPortal';

/** Only http(s) preview links are rendered (never javascript: or data: URLs). */
function safeHttpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * "Ready for your review": delivered work on THIS project waiting for the client's feedback.
 * Approve, Request changes (with a note), or just leave a comment. Hidden when nothing is pending.
 */
export function ClientReviewsCard({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<PortalClientReview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = () =>
    portalListClientReviews(projectId)
      .then((rows) => setItems(Array.isArray(rows) ? rows.filter((r) => r.project_id === projectId) : []))
      .catch(() => { /* keep last-known; card stays hidden when empty */ })
      .finally(() => setLoaded(true));

  useEffect(() => { void load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = items.filter((r) => r.status === 'pending');
  if (!loaded || pending.length === 0) return null;

  const setError = (id: string, msg: string | null) =>
    setErrors((p) => { const n = { ...p }; if (msg) n[id] = msg; else delete n[id]; return n; });

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(id, null);
    try {
      await fn();
      setDrafts((p) => ({ ...p, [id]: '' }));
      await load();
    } catch (err) {
      setError(id, err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-hud-bg-elev rounded-2xl border border-hud-gold/40">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-hud-cream">
        <ClipboardCheck className="w-4 h-4 text-hud-gold" />
        <h3 className="text-sm font-semibold text-hud-cream-soft">Ready for your review</h3>
        <span className="ml-auto text-xs text-hud-cream-dim">{pending.length} waiting for your feedback</span>
      </div>
      <div className="px-6 py-4 space-y-4">
        {pending.map((r) => {
          const busy = busyId === r.id;
          const draft = drafts[r.id] ?? '';
          const preview = safeHttpUrl(r.preview_url);
          return (
            <div key={r.id} className="rounded-xl border border-hud-line bg-hud-bg-mid/40 p-4 space-y-3">
              <div>
                <p className="text-sm text-hud-cream-soft font-medium leading-snug">{r.title}</p>
                <p className="text-xs text-hud-cream-dim mt-0.5 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {fmtDate(r.created_at)}{r.round > 1 ? ` · round ${r.round}` : ''}
                </p>
              </div>
              {r.summary && (
                <p className="text-xs text-hud-cream-mute leading-relaxed whitespace-pre-line">{r.summary}</p>
              )}
              {preview && (
                <a
                  href={preview}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-hud-gold hover:text-hud-gold-soft font-medium"
                >
                  Open the preview <ExternalLink className="w-3 h-3" />
                </a>
              )}

              {r.comments.length > 0 && (
                <div className="space-y-2 border-t border-hud-line pt-3">
                  {r.comments.map((c) => (
                    <div key={c.id} className="text-xs">
                      <span className="text-hud-cream-soft font-medium">
                        {c.author_type === 'client' ? (c.author_name || 'You') : (c.author_name || 'Team')}
                      </span>
                      <span className="text-hud-cream-dim"> · {fmtDate(c.created_at)}</span>
                      <p className="text-hud-cream-mute whitespace-pre-line mt-0.5">{c.body}</p>
                    </div>
                  ))}
                </div>
              )}

              <textarea
                value={draft}
                onChange={(e) => { setDrafts((p) => ({ ...p, [r.id]: e.target.value })); setError(r.id, null); }}
                rows={2}
                maxLength={10000}
                placeholder="Add a comment (required if you request changes)"
                className="w-full rounded-lg border border-hud-line bg-hud-bg-card px-3 py-2 text-xs text-hud-cream-soft placeholder:text-hud-cream-dim resize-y focus:outline-none focus:border-hud-gold/60"
              />
              {errors[r.id] && <p className="text-xs text-hud-rust">{errors[r.id]}</p>}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void run(r.id, () => portalDecideClientReview(r.id, 'approve', draft.trim() || undefined))}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-hud-gold/90 hover:bg-hud-gold text-hud-bg-card text-xs font-medium transition-colors disabled:opacity-60"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {busy ? 'Working…' : 'Approve'}
                </button>
                <button
                  onClick={() => {
                    if (!draft.trim()) { setError(r.id, 'Tell us what should change.'); return; }
                    void run(r.id, () => portalDecideClientReview(r.id, 'request_changes', draft.trim()));
                  }}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-hud-line text-hud-cream-dim hover:text-hud-cream-soft text-xs transition-colors disabled:opacity-60"
                >
                  <PencilLine className="w-3.5 h-3.5" />
                  Request changes
                </button>
                <button
                  onClick={() => {
                    if (!draft.trim()) { setError(r.id, 'Write a comment first.'); return; }
                    void run(r.id, () => portalAddClientReviewComment(r.id, draft.trim()));
                  }}
                  disabled={busy}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-hud-cream-dim hover:text-hud-cream-soft text-xs transition-colors disabled:opacity-60"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Comment only
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
