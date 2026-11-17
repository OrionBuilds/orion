import { useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { usePushNotifications } from '../../hooks/usePushNotifications';

const DISMISS_KEY = 'orion.pushPrompt.dismissedAt';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** One-time nudge on Home: notifications are how the phone replaces sitting at the desk. */
export function EnableNotificationsCard() {
  const { status, busy, error, enable } = usePushNotifications();
  const [hidden, setHidden] = useState(() => {
    const t = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return t > 0 && Date.now() - t < SNOOZE_MS;
  });
  if (hidden || status === 'on' || status === 'unsupported' || status === 'not-configured' || status === 'blocked') return null;

  return (
    <section className="rounded-xl border border-hud-gold/40 bg-hud-gold/10 p-3 sm:hidden" data-testid="enable-notifications">
      <div className="flex items-start gap-3">
        <BellRing className="w-5 h-5 mt-0.5 shrink-0 text-hud-gold-soft" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">Get notified on this phone</p>
          <p className="text-xs text-hud-cream-dim mt-0.5">
            {status === 'needs-install'
              ? 'Add the app to your Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on.'
              : 'New messages, approvals, and anything Clara, Friday or Harvey need from you.'}
          </p>
          {status === 'off' && (
            <button type="button" onClick={enable} disabled={busy} className="mt-2 rounded-lg bg-hud-gold-deep px-4 py-2 text-sm font-medium text-white touch-manipulation disabled:opacity-60">
              {busy ? 'Turning on…' : 'Turn on notifications'}
            </button>
          )}
          {error && <p className="mt-1 text-xs text-hud-plum">{error}</p>}
        </div>
        <button type="button" aria-label="Dismiss" onClick={() => { localStorage.setItem(DISMISS_KEY, String(Date.now())); setHidden(true); }} className="p-1 text-hud-cream-dim touch-manipulation">
          <X className="w-4 h-4" />
        </button>
      </div>
    </section>
  );
}
