import { sanitizeOtp } from '../../lib/mfa';

interface OtpCodeInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  label?: string;
}

export function OtpCodeInput({
  id,
  value,
  onChange,
  maxLength = 6,
  autoFocus,
  disabled,
  label = 'Verification code',
}: OtpCodeInputProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-hud-cream-soft mb-2">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={maxLength}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => onChange(sanitizeOtp(e.target.value, maxLength))}
        placeholder={'0'.repeat(Math.min(maxLength, 6))}
        className="w-full px-4 py-2.5 rounded-lg bg-hud-bg-mid border border-hud-cream-mute text-white text-center text-xl tracking-[0.5em] font-mono placeholder-hud-cream-mute focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:opacity-50"
      />
    </div>
  );
}
