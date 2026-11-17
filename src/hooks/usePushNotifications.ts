import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { currentSubscription, disablePush, enablePush, isPushConfigured, pushStatus, readPushEnv, savePushSubscription, type PushStatus } from '../lib/webPush';

/** Notification state for this device and the actions to change it. */
export function usePushNotifications() {
  const { user } = useAuth();
  const [status, setStatus] = useState<PushStatus>('off');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const sub = await currentSubscription();
    // A subscription only counts once the server holds it; re-saving here repairs a save that failed earlier.
    let saved = !!sub;
    if (sub && user && readPushEnv(true).permission === 'granted') {
      try {
        await savePushSubscription(sub, user.id, user.organization_id);
        setError(null);
      } catch (e) {
        saved = false;
        setError(`This device is subscribed, but saving it failed: ${e instanceof Error ? e.message : 'unknown error'}. Tap to try again.`);
      }
    }
    const env = readPushEnv(saved);
    // Only ask the server whether push is configured when the device could use it.
    const configured = env.permission === 'granted' && sub ? true : (pushStatus(env) === 'off' ? await isPushConfigured() : true);
    setStatus(pushStatus(env, configured));
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const enable = useCallback(async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await enablePush(user.id, user.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn notifications on');
    } finally {
      setBusy(false);
    }
  }, [user]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await disablePush();
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { status, busy, error, enable, disable, refresh };
}

/** Keep the server's copy of this device's subscription current on every load, wherever the app was opened. */
export function usePushSync() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const sub = await currentSubscription();
      if (!sub || readPushEnv(true).permission !== 'granted') return;
      await savePushSubscription(sub, user.id, user.organization_id).catch((e) => console.warn('[push] could not save this device:', e));
    })();
  }, [user]);
}
