import { useState, useSyncExternalStore } from 'react';
import { Download, Share } from 'lucide-react';
import { useDevice } from '../contexts/DeviceContext';
import { hasInstallPrompt, installState, promptInstall, subscribeInstall } from '../lib/installPrompt';

/** "Install app" row for the user menu: real install button on Chrome, Add-to-Home-Screen steps on iPhone/iPad, hidden once installed. */
export function InstallAppMenuItem({ onDone }: { onDone?: () => void }) {
  const { isStandalone, isIOS } = useDevice();
  const hasPrompt = useSyncExternalStore(subscribeInstall, hasInstallPrompt, () => false);
  const [showSteps, setShowSteps] = useState(false);
  const state = installState({ standalone: isStandalone, hasPrompt, isIOS });
  if (state === 'installed' || state === 'unavailable') return null;

  if (state === 'available') {
    return (
      <button
        onClick={async () => { await promptInstall(); onDone?.(); }}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev rounded-md transition-colors touch-manipulation tap-target"
      >
        <Download className="w-4 h-4" />
        Install app
      </button>
    );
  }

  return (
    <div>
      <button
        onClick={() => setShowSteps((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev rounded-md transition-colors touch-manipulation tap-target"
      >
        <Download className="w-4 h-4" />
        Install app
      </button>
      {showSteps && (
        <p className="px-3 pb-2 text-xs text-hud-cream-dim leading-relaxed">
          Tap <Share className="inline w-3.5 h-3.5 -mt-0.5" /> Share, then <strong>Add to Home Screen</strong>.
        </p>
      )}
    </div>
  );
}
