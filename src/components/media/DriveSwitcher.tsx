import { HardDrive } from 'lucide-react';
import { PROVIDER_LABELS, type WorkspaceProvider } from '../../services/connectedProvider';
import type { DriveOption } from '../../hooks/useFilesProvider';

export const CONNECT_ACCOUNTS_HREF = '/settings/profile?tab=connected-accounts';

interface DriveSwitcherProps {
  options: DriveOption[];
  active: WorkspaceProvider | null;
  /** Called only for a connected drive; the parent saves the choice and reloads its listing. */
  onSelect: (p: WorkspaceProvider) => void;
  className?: string;
}

/**
 * Switch between the user's cloud drives (Google Drive, SharePoint/OneDrive). Both are always shown:
 * a connected one is selectable, an unconnected one links to Connected accounts, so a user who has
 * only one connected can see (and add) the other.
 */
export default function DriveSwitcher({ options, active, onSelect, className = '' }: DriveSwitcherProps) {
  return (
    <div role="group" aria-label="Cloud drive" className={`flex items-center gap-1 rounded-lg bg-hud-bg-mid p-0.5 ${className}`}>
      {options.map((o) => {
        const label = PROVIDER_LABELS[o.provider].files;
        if (!o.connected) {
          return (
            <a
              key={o.provider}
              href={CONNECT_ACCOUNTS_HREF}
              title={`Connect ${PROVIDER_LABELS[o.provider].suite} to use ${label}`}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md text-hud-cream-mute hover:text-white border border-dashed border-hud-bg-elev"
            >
              <HardDrive className="w-3 h-3" />
              Connect {label}
            </a>
          );
        }
        const isActive = o.provider === active;
        return (
          <button
            key={o.provider}
            type="button"
            aria-pressed={isActive}
            title={o.email ? `${label} - ${o.email}` : label}
            onClick={() => { if (!isActive) onSelect(o.provider); }}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors ${isActive ? 'bg-hud-gold text-black font-medium' : 'text-hud-cream-dim hover:text-white'}`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
