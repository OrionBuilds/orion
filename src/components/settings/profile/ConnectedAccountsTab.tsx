import { AlertCircle } from 'lucide-react';
import { MicrosoftConnectionCard } from './MicrosoftConnectionCard';
import { GoogleConnectionCard } from './GoogleConnectionCard';

export function ConnectedAccountsTab() {
  return (
    <div className="space-y-4">
      <MicrosoftConnectionCard />
      <GoogleConnectionCard />

      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-hud-gold-soft flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-semibold text-white mb-1">About Connected Accounts</h4>
            <p className="text-sm text-hud-cream-dim leading-relaxed">
              Connecting Google Workspace grants access to Gmail, Calendar, Meet, and Drive in a single
              sign-in. All services share one secure connection so they never interfere with each other.
              Outbound emails go through your Gmail account. Busy times from Calendar sync to prevent
              double-bookings. You can disconnect at any time, which immediately revokes access but
              won't delete previously synced data.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
