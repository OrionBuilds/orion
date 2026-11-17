/**
 * "Install app" support. Chrome (Android, desktop) fires `beforeinstallprompt` once, early, so it is captured here at
 * startup (imported from main.tsx, before React mounts) and replayed when the user taps Install. iPhone/iPad have no
 * install prompt: Share -> Add to Home Screen, which we explain instead.
 */
export type InstallState = 'installed' | 'available' | 'ios' | 'unavailable';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function installState(i: { standalone: boolean; hasPrompt: boolean; isIOS: boolean }): InstallState {
  if (i.standalone) return 'installed';
  if (i.hasPrompt) return 'available';
  if (i.isIOS) return 'ios';
  return 'unavailable';
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function captureInstallPrompt(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export const hasInstallPrompt = () => deferred !== null;

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Shows the browser's install dialog. Resolves true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const ev = deferred;
  deferred = null; // the event can only be used once
  notify();
  await ev.prompt();
  const choice = await ev.userChoice;
  return choice.outcome === 'accepted';
}
