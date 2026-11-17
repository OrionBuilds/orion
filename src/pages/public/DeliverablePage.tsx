import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Loader2, ShieldCheck, AlertCircle } from 'lucide-react';
import { sanitizeHtml } from '../../utils/sanitizeHtml';

/**
 * Public client-deliverable page. Renders a branded report the client received a link to.
 * Reads ONLY through the token-verified deliverable-publish edge function (get_public) — the
 * client_deliverables table has no anon RLS policy, so a raw anon query returns nothing. The
 * raw token from the URL is verified against access_token_hash server-side.
 */

interface Deliverable {
  id: string;
  title: string;
  summary: string | null;
  html_content: string;
  created_at: string;
  company: { name: string; email: string; phone: string };
}

export function DeliverablePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [data, setData] = useState<Deliverable | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id || !token) { setState('error'); setError('This link is missing its access token.'); return; }
    (async () => {
      try {
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/deliverable-publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
          body: JSON.stringify({ action: 'get_public', id, token }),
        });
        if (!res.ok) {
          setState('error');
          setError(res.status === 403 || res.status === 404 ? 'This link is invalid or has expired.' : 'Could not load this report.');
          return;
        }
        setData(await res.json());
        setState('ready');
      } catch {
        setState('error');
        setError('Could not load this report. Please check your connection.');
      }
    })();
  }, [id, token]);

  if (state === 'loading') {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-hud-bg-deep text-hud-cream-dim">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading your report…
      </div>
    );
  }

  if (state === 'error' || !data) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-hud-bg-deep px-6">
        <div className="max-w-md text-center">
          <AlertCircle className="w-10 h-10 text-hud-plum mx-auto mb-4" />
          <h1 className="text-lg font-semibold text-white mb-2">Report unavailable</h1>
          <p className="text-sm text-hud-cream-dim">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-hud-bg-deep text-hud-cream">
      <header className="bg-hud-bg-mid border-b border-hud-bg-card">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="text-white font-bold text-lg">{data.company.name}</div>
          <div className="flex items-center gap-1.5 text-xs text-hud-cream-mute">
            <ShieldCheck className="w-3.5 h-3.5 text-hud-gold-soft" /> Private link
          </div>
        </div>
        <div className="h-1 bg-hud-gold-soft" />
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-white mb-1">{data.title}</h1>
        <p className="text-xs text-hud-cream-mute mb-6">{new Date(data.created_at).toLocaleDateString(undefined, { dateStyle: 'long' })}</p>
        {data.summary && <p className="text-sm text-hud-cream-soft leading-relaxed mb-8 border-l-2 border-hud-gold/40 pl-4">{data.summary}</p>}
        <article
          className="prose prose-invert prose-sm max-w-none prose-headings:text-white prose-a:text-hud-gold-soft"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(data.html_content) }}
        />
      </main>

      <footer className="max-w-3xl mx-auto px-6 py-8 border-t border-hud-bg-card mt-8">
        <p className="text-xs text-hud-cream-mute">
          Questions? Contact us at{' '}
          <a href={`mailto:${data.company.email}`} className="text-hud-gold-soft">{data.company.email}</a> or {data.company.phone}.
        </p>
        <p className="text-xs text-hud-cream-mute mt-1">{data.company.name}</p>
      </footer>
    </div>
  );
}
