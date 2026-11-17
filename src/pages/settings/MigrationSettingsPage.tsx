import { Database } from 'lucide-react';
import { GHLImporter } from '../../components/settings/GHLImporter';

export function MigrationSettingsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="p-3 rounded-xl bg-hud-rust/10 border border-hud-rust/30">
          <Database className="w-6 h-6 text-hud-rust" />
        </div>
        <div>
          <h2 className="text-2xl font-semibold text-white">Data Migration</h2>
          <p className="text-sm text-hud-cream-dim mt-1">
            One-time imports from external CRMs into the active organization.
            All importers are idempotent — re-runs skip records already imported.
            Imports run in the active org context (use OrgSwitcher to target the right tenant).
          </p>
        </div>
      </div>

      <GHLImporter />
    </div>
  );
}
