/**
 * Browser side of Web Push. The owner turns notifications on once per device: permission, a push subscription from the
 * service worker (public/sw.js), and a row in push_subscriptions that the send-push edge function delivers to.
 */
import { supabase } from './supabase';

export type PushStatus = 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on' | 'not-configured';

/** VAPID public keys are base64url; the Push API wants bytes. */
export function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | 'unsupported';
  isIOS: boolean;
  isStandalone: boolean;
  /** The browser holds a subscription AND the server has it: a subscription nobody delivers to is not "on". */
  subscribed: boolean;
}

/** iPhone/iPad only allow Web Push from an installed (Add to Home Screen) app. */
export function pushStatus(e: PushEnv, configured = true): PushStatus {
  if (!e.hasServiceWorker || !e.hasNotification) return e.isIOS && !e.isStandalone ? 'needs-install' : 'unsupported';
  if (e.isIOS && !e.isStandalone) return 'needs-install';
  if (!e.hasPushManager) return 'unsupported';
  if (e.permission === 'denied') return 'blocked';
  if (!configured) return 'not-configured';
  if (e.permission === 'granted' && e.subscribed) return 'on';
  return 'off';
}

export function readPushEnv(subscribed: boolean): PushEnv {
  const w = typeof window === 'undefined' ? undefined : window;
  const nav = (w?.navigator ?? {}) as Navigator & { standalone?: boolean };
  const ua = nav.userAgent ?? '';
  return {
    hasServiceWorker: !!w && 'serviceWorker' in nav,
    hasPushManager: !!w && 'PushManager' in w,
    hasNotification: !!w && 'Notification' in w,
    permission: w && 'Notification' in w ? Notification.permission : 'unsupported',
    isIOS: /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1),
    isStandalone: !!w && (w.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true),
    subscribed,
  };
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.ready);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    const reg = await registration();
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

async function publicKey(): Promise<string> {
  const { data, error } = await supabase.functions.invoke('push-config');
  if (error) throw error;
  return (data as { publicKey?: string })?.publicKey ?? '';
}

export async function isPushConfigured(): Promise<boolean> {
  try { return (await publicKey()).length > 0; } catch { return false; }
}

/** Pure: was this subscription made with the server's current key? One made with another key can never be delivered to. */
export function sameServerKey(subscriptionKey: ArrayBuffer | null | undefined, serverKey: string): boolean {
  if (!subscriptionKey) return true; // the browser does not say: assume it is ours
  const a = new Uint8Array(subscriptionKey), b = urlBase64ToUint8Array(serverKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const saving = new Map<string, Promise<void>>();

/**
 * Write this device's subscription for this user (idempotent). The browser keeps its subscription whether or not
 * the server ever stored it, so this runs on every load as well as when notifications are turned on: a save that
 * failed once repairs itself. Concurrent callers share one write.
 */
export function savePushSubscription(sub: PushSubscription, userId: string, orgId: string | null | undefined): Promise<void> {
  const k = `${userId}|${sub.endpoint}`;
  let p = saving.get(k);
  if (!p) {
    p = (async () => {
      const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error('The browser returned an incomplete push subscription');
      const { error } = await supabase.from('push_subscriptions').upsert(
        { user_id: userId, org_id: orgId ?? null, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200), disabled_at: null, failure_count: 0 },
        { onConflict: 'endpoint' },
      );
      if (error) throw new Error(error.message || 'The server did not save this device');
    })();
    saving.set(k, p);
    p.catch(() => saving.delete(k)); // a failed save may be tried again
  }
  return p;
}

/** Ask permission, subscribe, and save the subscription for this user. Returns the resulting status. */
export async function enablePush(userId: string, orgId: string | null | undefined): Promise<PushStatus> {
  const key = await publicKey();
  if (!key) return 'not-configured';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'blocked' : 'off';
  const reg = await registration();
  if (!reg) return 'unsupported';
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameServerKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  await savePushSubscription(sub, userId, orgId);
  return 'on';
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  saving.clear();
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
}
