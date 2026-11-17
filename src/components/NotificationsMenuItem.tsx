import { Bell, BellOff, BellRing } from 'lucide-react';
import { usePushNotifications } from '../hooks/usePushNotifications';

/** Header menu row: turn this device's notifications on or off, with the reason when it cannot be done. */
export function NotificationsMenuItem() {
  const { status, busy, error, enable, disable } = usePushNotifications();
  const row = 'w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev rounded-md transition-colors touch-manipulation tap-target';

  if (status === 'unsupported') return null;
  if (status === 'needs-install') {
    return <p className="px-3 py-2 text-xs text-hud-cream-dim leading-relaxed">To get notifications on iPhone or iPad, add the app to your Home Screen first (Share → Add to Home Screen), then open it from there.</p>;
  }
  if (status === 'blocked') {
    return <p className="px-3 py-2 text-xs text-hud-cream-dim leading-relaxed"><BellOff className="inline w-3.5 h-3.5 -mt-0.5 mr-1" />Notifications are blocked for this site. Allow them in your browser's site settings.</p>;
  }
  if (status === 'not-configured') {
    return <p className="px-3 py-2 text-xs text-hud-cream-dim leading-relaxed">Notifications aren't set up on the server yet.</p>;
  }
  if (status === 'on') {
    return (
      <button type="button" onClick={disable} disabled={busy} className={row}>
        <BellRing className="w-4 h-4 text-hud-emerald" /> Notifications on <span className="ml-auto text-xs text-hud-cream-dim">Turn off</span>
      </button>
    );
  }
  return (
    <div>
      <button type="button" onClick={enable} disabled={busy} className={row}>
        <Bell className="w-4 h-4" /> {busy ? 'Turning on…' : 'Turn on notifications'}
      </button>
      {error && <p className="px-3 pb-2 text-xs text-hud-plum">{error}</p>}
    </div>
  );
}
