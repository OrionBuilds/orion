import { ChevronDown } from 'lucide-react';
import { accountDisplayName, showAccountPicker, type MsAccount } from '../../lib/microsoftAccounts';

interface MicrosoftAccountSelectProps {
  accounts: MsAccount[];
  value: string | null;
  onChange: (connectionId: string) => void;
  label?: string;
  /** Extra leading option, e.g. "Not added to Outlook" (value ''). */
  noneLabel?: string;
  className?: string;
  compact?: boolean;
}

/** Small account chooser for Microsoft 365 (calendar, files). Renders nothing below two accounts. */
export function MicrosoftAccountSelect({ accounts, value, onChange, label, noneLabel, className = '', compact = true }: MicrosoftAccountSelectProps) {
  if (!showAccountPicker(accounts)) return null;
  return (
    <label className={`flex items-center gap-2 min-w-0 ${className}`}>
      {label && <span className="text-xs text-hud-cream-mute shrink-0">{label}</span>}
      <span className="relative min-w-0">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label ?? 'Microsoft account'}
          className={`appearance-none bg-hud-bg-mid border border-hud-cream-mute rounded-lg pl-3 pr-8 py-1.5 ${compact ? 'text-xs' : 'text-sm'} text-white font-medium focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent max-w-[260px] truncate cursor-pointer`}
        >
          {noneLabel !== undefined && <option value="">{noneLabel}</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountDisplayName(a)}{a.isPrimary ? ' - Primary' : ''}
            </option>
          ))}
        </select>
        <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-hud-cream-dim pointer-events-none" />
      </span>
    </label>
  );
}
