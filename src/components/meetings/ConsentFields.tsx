import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { CONSENT_BASES, CONSENT_SCRIPTS } from '../../../supabase/functions/_shared/meeting-consent';
import type { ConsentValue } from './consentState';

/**
 * How participants were told about the recording. Required before a transcript is imported or a recording is
 * transcribed; the answer is stored on the meeting as the audit trail. Scripts are there to copy into the
 * next invite or to read at the start of the call.
 */
export function ConsentFields({ value, onChange }: { value: ConsentValue; onChange: (v: ConsentValue) => void }) {
  const [showScripts, setShowScripts] = useState(false);
  return (
    <fieldset className="space-y-2 rounded-lg border border-hud-bg-elev p-3">
      <legend className="flex items-center gap-1.5 px-1 text-xs font-medium text-hud-gold">
        <ShieldCheck className="h-3.5 w-3.5" /> Recording consent (required)
      </legend>
      <select
        value={value.basis}
        onChange={(e) => onChange({ ...value, basis: e.target.value as ConsentValue['basis'] })}
        className="w-full rounded-lg border border-hud-bg-elev bg-hud-bg px-3 py-2 text-sm text-hud-text"
        aria-label="How participants were told about the recording"
      >
        <option value="">How were participants told it was being recorded?</option>
        {CONSENT_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
      </select>
      <input
        value={value.note}
        onChange={(e) => onChange({ ...value, note: e.target.value.slice(0, 500) })}
        placeholder="Optional note (who agreed, which state's rule you checked)"
        aria-label="Optional recording-consent note"
        className="w-full rounded-lg border border-hud-bg-elev bg-hud-bg px-3 py-2 text-sm text-hud-text"
      />
      <button type="button" onClick={() => setShowScripts((s) => !s)} className="text-xs text-hud-gold hover:underline">
        {showScripts ? 'Hide' : 'Show'} wording for invites and the start of a call
      </button>
      {showScripts && (
        <ul className="space-y-1 text-xs text-hud-text-dim">
          <li><span className="text-hud-cream">Invite:</span> {CONSENT_SCRIPTS.invite}</li>
          <li><span className="text-hud-cream">Announcement:</span> {CONSENT_SCRIPTS.announcement}</li>
          <li><span className="text-hud-cream">Ask:</span> {CONSENT_SCRIPTS.ask}</li>
        </ul>
      )}
      <p className="text-[11px] text-hud-cream-mute">Recording law differs by state. This records what you stated; it is not legal advice.</p>
    </fieldset>
  );
}
