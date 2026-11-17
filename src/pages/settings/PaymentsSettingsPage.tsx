import { useEffect, useState } from 'react';
import { CreditCard, Loader2 } from 'lucide-react';
import { StripeConfig } from '../../components/settings/StripeConfig';
import { QBOConfig } from '../../components/settings/QBOConfig';
import { getActivePaymentsProvider } from '../../services/stripeAuth';

export function PaymentsSettingsPage() {
  const [activeProvider, setActiveProvider] = useState<'stripe' | 'quickbooks_online' | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getActivePaymentsProvider();
        if (!cancelled) setActiveProvider(p);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="p-3 rounded-xl bg-hud-emerald/10 border border-hud-emerald/30">
          <CreditCard className="w-6 h-6 text-hud-emerald" />
        </div>
        <div>
          <h2 className="text-2xl font-semibold text-white">Payments</h2>
          <p className="text-sm text-hud-cream-dim mt-1">
            Connect a payment provider to send invoices, accept payments, and sync customers.
            Stripe and QuickBooks Online both store credentials encrypted; you can connect either or both.
          </p>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-hud-gold-soft" />
        </div>
      )}

      {!loading && (
        <div className="space-y-4">
          {activeProvider && (
            <div className="rounded-lg bg-hud-bg-card/50 border border-hud-bg-elev p-3 text-xs text-hud-cream-dim">
              <span className="text-hud-cream-soft font-medium">Active provider for invoice creation: </span>
              <span className="text-hud-gold-soft font-medium">
                {activeProvider === 'stripe' ? 'Stripe' : 'QuickBooks Online'}
              </span>
              <span className="ml-2 text-hud-cream-mute">
                — invoice creation routes here. Both providers can be connected; if both are present, Stripe wins.
              </span>
            </div>
          )}

          <StripeConfig />
          <QBOConfig />
        </div>
      )}
    </div>
  );
}
