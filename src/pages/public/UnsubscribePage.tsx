import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle, CheckCircle, MailX } from 'lucide-react';

/**
 * Public unsubscribe confirm page (/unsubscribe/:slug) — the footer link on Resend emails sent
 * with an org default unsubscribe group. The email-unsubscribe edge function never acts on a GET
 * (mail scanners prefetch links); this page shows the address and POSTs on an explicit click.
 * The slug is the only credential; the anon key just satisfies the gateway.
 */

type State = 'loading' | 'confirm' | 'submitting' | 'done' | 'error';

function endpoint(slug: string): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/email-unsubscribe/${encodeURIComponent(slug)}`;
}

function headers(): HeadersInit {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
  };
}

export function UnsubscribePage() {
  const { slug } = useParams<{ slug: string }>();
  const [state, setState] = useState<State>('loading');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!slug) {
      setState('error');
      setError('This unsubscribe link is incomplete.');
      return;
    }
    (async () => {
      try {
        const res = await fetch(endpoint(slug), { method: 'GET', headers: headers() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          setState('error');
          setError(data.error || 'This unsubscribe link is invalid or has expired.');
          return;
        }
        setEmail(data.email || '');
        setState('confirm');
      } catch {
        setState('error');
        setError('Could not load this page. Please check your connection.');
      }
    })();
  }, [slug]);

  const confirm = async () => {
    if (!slug) return;
    setState('submitting');
    try {
      const res = await fetch(endpoint(slug), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setState('error');
        setError(data.error || 'We could not process your request. Reply UNSUBSCRIBE to the email instead.');
        return;
      }
      setEmail(data.email || email);
      setState('done');
    } catch {
      setState('error');
      setError('We could not process your request. Reply UNSUBSCRIBE to the email instead.');
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-hud-bg-deep px-6">
      <div className="max-w-md w-full text-center bg-hud-bg-card border border-hud-bg-elev rounded-lg p-8">
        {state === 'loading' && (
          <div className="flex items-center justify-center text-hud-cream-dim">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        )}

        {(state === 'confirm' || state === 'submitting') && (
          <>
            <MailX className="w-10 h-10 text-hud-gold-soft mx-auto mb-4" />
            <h1 className="text-lg font-semibold text-white mb-2">Unsubscribe from these emails?</h1>
            <p className="text-sm text-hud-cream-dim mb-6">
              {email ? <><span className="text-hud-cream-soft">{email}</span> will stop receiving our emails.</> : 'You will stop receiving our emails.'}
            </p>
            <button
              type="button"
              onClick={confirm}
              disabled={state === 'submitting'}
              className="inline-flex items-center justify-center px-5 py-2 rounded-md text-sm font-medium text-white bg-hud-gold-deep hover:bg-hud-gold disabled:opacity-50"
            >
              {state === 'submitting' && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Unsubscribe
            </button>
          </>
        )}

        {state === 'done' && (
          <>
            <CheckCircle className="w-10 h-10 text-hud-emerald mx-auto mb-4" />
            <h1 className="text-lg font-semibold text-white mb-2">You're unsubscribed</h1>
            <p className="text-sm text-hud-cream-dim">
              {email || 'Your address'} will not receive further emails from us. If this was a mistake, reply to
              any of our previous emails and let us know.
            </p>
          </>
        )}

        {state === 'error' && (
          <>
            <AlertCircle className="w-10 h-10 text-hud-plum mx-auto mb-4" />
            <h1 className="text-lg font-semibold text-white mb-2">Link unavailable</h1>
            <p className="text-sm text-hud-cream-dim">{error}</p>
          </>
        )}
      </div>
    </div>
  );
}
