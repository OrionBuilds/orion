import { useState, useEffect } from 'react';
import { AlertCircle, Loader2, ToggleLeft, ToggleRight, X } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getFeatureFlags, updateFeatureFlag } from '../../../services/featureFlags';
import type { FeatureFlag } from '../../../types';

// Moved here from Settings → Organization. SuperAdmins toggle modules; everyone else sees status only.
export function FeatureFlagsTab() {
  const { user, isSuperAdmin } = useAuth();
  const [featureFlags, setFeatureFlags] = useState<FeatureFlag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingFlag, setTogglingFlag] = useState<string | null>(null);

  useEffect(() => {
    const orgId = user?.organization?.id ?? user?.organization_id;
    if (!orgId) return;
    setIsLoading(true);
    getFeatureFlags(orgId)
      .then(setFeatureFlags)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load feature flags'))
      .finally(() => setIsLoading(false));
  }, [user]);

  const handleToggleFlag = async (flag: FeatureFlag) => {
    if (!isSuperAdmin) return;

    setTogglingFlag(flag.id);
    setError(null);

    try {
      const updated = await updateFeatureFlag(flag.id, !flag.enabled);
      setFeatureFlags((prev) =>
        prev.map((f) => (f.id === flag.id ? updated : f))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update feature flag');
    } finally {
      setTogglingFlag(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20 text-hud-plum text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
        <div className="p-4 border-b border-hud-bg-card">
          <h3 className="text-lg font-semibold text-white">Feature Flags</h3>
          <p className="text-sm text-hud-cream-dim mt-1">
            {isSuperAdmin
              ? 'Enable or disable modules for your organization'
              : 'Module activation status (read-only)'}
          </p>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {featureFlags.map((flag) => (
              <div
                key={flag.id}
                className="flex items-center justify-between p-3 rounded-lg bg-hud-bg-card/50"
              >
                <div className="flex-1 min-w-0 pr-3">
                  <p className="text-white capitalize">{flag.key.replace(/_/g, ' ')}</p>
                  {flag.description && (
                    <p className="text-xs text-hud-cream-dim line-clamp-2">{flag.description}</p>
                  )}
                </div>
                {isSuperAdmin ? (
                  <button
                    onClick={() => handleToggleFlag(flag)}
                    disabled={togglingFlag === flag.id}
                    className="flex-shrink-0 transition-colors disabled:opacity-50"
                  >
                    {togglingFlag === flag.id ? (
                      <Loader2 className="w-6 h-6 animate-spin text-hud-gold-soft" />
                    ) : flag.enabled ? (
                      <ToggleRight className="w-6 h-6 text-hud-emerald hover:text-hud-emerald/40" />
                    ) : (
                      <ToggleLeft className="w-6 h-6 text-hud-cream-mute hover:text-hud-cream-dim" />
                    )}
                  </button>
                ) : flag.enabled ? (
                  <ToggleRight className="w-6 h-6 text-hud-emerald flex-shrink-0" />
                ) : (
                  <ToggleLeft className="w-6 h-6 text-hud-cream-mute flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
