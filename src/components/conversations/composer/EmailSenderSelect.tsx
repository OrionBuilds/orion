import { ChevronDown } from 'lucide-react';
import {
  accountDisplayName,
  decodeOutlookOption,
  encodeOutlookOption,
  showAccountPicker,
  type MsAccount,
} from '../../../lib/microsoftAccounts';
import { decodeGmailOption, encodeGmailOption, type GoogleAccount } from '../../../lib/googleAccounts';

export type SendVia = 'resend' | 'gmail' | 'outlook';

interface EmailSenderSelectProps {
  value: SendVia;
  onChange: (v: SendVia) => void;
  gmailConnected: boolean;
  gmailAddress?: string | null;
  microsoftConnected?: boolean;
  microsoftAddress?: string | null;
  /** All Microsoft accounts; with 2+ the Outlook entry becomes one entry per account. */
  microsoftAccounts?: MsAccount[];
  /** The account selected when `value` is 'outlook'. */
  microsoftConnectionId?: string | null;
  onMicrosoftConnectionChange?: (connectionId: string) => void;
  /** All Google accounts; with 2+ the Gmail entry becomes one entry per account. */
  googleAccounts?: GoogleAccount[];
  /** The account selected when `value` is 'gmail'. */
  googleConnectionId?: string | null;
  onGoogleConnectionChange?: (connectionId: string) => void;
  sendgridName?: string;
  sendgridEmail?: string;
  /** Compact label sizing for the inline reply composer */
  compact?: boolean;
  className?: string;
}

/**
 * "From" sender chooser for outbound email in the Conversations module.
 * Lets the logged-in user pick between the org Resend sender and their own
 * connected Gmail. When Gmail isn't connected it renders the Resend sender as
 * static text (preserving the prior UX).
 */
export function EmailSenderSelect({
  value,
  onChange,
  gmailConnected,
  gmailAddress,
  microsoftConnected = false,
  microsoftAddress,
  microsoftAccounts = [],
  microsoftConnectionId = null,
  onMicrosoftConnectionChange,
  googleAccounts = [],
  googleConnectionId = null,
  onGoogleConnectionChange,
  sendgridName,
  sendgridEmail,
  compact = false,
  className = '',
}: EmailSenderSelectProps) {
  const sendgridLabel = sendgridEmail
    ? `${sendgridName ? `${sendgridName} · ` : ''}${sendgridEmail}`
    : 'Org email (Resend)';
  const gmailLabel = `My Gmail${gmailAddress ? ` · ${gmailAddress}` : ''}`;
  const outlookLabel = `My Outlook${microsoftAddress ? ` · ${microsoftAddress}` : ''}`;

  const multiMs = microsoftConnected && showAccountPicker(microsoftAccounts);
  const multiGoogle = gmailConnected && showAccountPicker(googleAccounts);
  const selectValue = multiMs && value === 'outlook'
    ? encodeOutlookOption(microsoftConnectionId ?? microsoftAccounts.find((a) => a.isPrimary)?.id ?? microsoftAccounts[0].id)
    : multiGoogle && value === 'gmail'
      ? encodeGmailOption(googleConnectionId ?? googleAccounts.find((a) => a.isPrimary)?.id ?? googleAccounts[0].id)
      : value;
  const handleChange = (v: string) => {
    const connectionId = decodeOutlookOption(v);
    const gmailConnectionId = decodeGmailOption(v);
    if (connectionId) {
      onMicrosoftConnectionChange?.(connectionId);
      onChange('outlook');
    } else if (gmailConnectionId) {
      onGoogleConnectionChange?.(gmailConnectionId);
      onChange('gmail');
    } else {
      onChange(v as SendVia);
    }
  };

  const labelSize = compact ? 'text-xs' : 'text-sm';

  if (!gmailConnected && !microsoftConnected) {
    return (
      <div className={`flex items-center gap-2 min-w-0 ${className}`}>
        <span className="text-xs text-hud-cream-mute shrink-0">From:</span>
        <span className={`${labelSize} text-white font-medium truncate`}>{sendgridLabel}</span>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`}>
      <span className="text-xs text-hud-cream-mute shrink-0">From:</span>
      <div className="relative min-w-0">
        <select
          value={selectValue}
          onChange={(e) => handleChange(e.target.value)}
          title="Choose which account to send from"
          className={`appearance-none bg-hud-bg-mid border border-hud-cream-mute rounded-lg pl-3 pr-8 py-1.5 ${labelSize} text-white font-medium focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent max-w-[280px] truncate cursor-pointer`}
        >
          {multiMs
            ? microsoftAccounts.map((a) => (
              <option key={a.id} value={encodeOutlookOption(a.id)}>
                Outlook · {accountDisplayName(a)}{a.isPrimary ? ' (primary)' : ''}
              </option>
            ))
            : microsoftConnected && <option value="outlook">{outlookLabel}</option>}
          {multiGoogle
            ? googleAccounts.map((a) => (
              <option key={a.id} value={encodeGmailOption(a.id)}>
                Gmail · {accountDisplayName(a)}{a.isPrimary ? ' (primary)' : ''}
              </option>
            ))
            : gmailConnected && <option value="gmail">{gmailLabel}</option>}
          <option value="resend">{sendgridLabel}</option>
        </select>
        <ChevronDown
          size={14}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-hud-cream-dim pointer-events-none"
        />
      </div>
    </div>
  );
}
