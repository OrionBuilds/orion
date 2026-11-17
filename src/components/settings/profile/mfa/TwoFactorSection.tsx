import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2, MessageSquare, Plus, Smartphone, Trash2 } from 'lucide-react';
import { useAuth } from '../../../../contexts/AuthContext';
import { describeMfaError, maskPhone, PHONE_MFA_DISABLED_MESSAGE } from '../../../../lib/mfa';
import { listMfaFactors, type MfaFactor } from '../../../../services/mfa';
import { logAudit } from '../../../../services/audit';
import { TotpEnrollModal } from './TotpEnrollModal';
import { SmsEnrollModal } from './SmsEnrollModal';
import { RemoveFactorModal } from './RemoveFactorModal';

type Modal = { kind: 'totp' } | { kind: 'sms' } | { kind: 'remove'; factor: MfaFactor } | null;

/** Settings -> My Profile -> Security: manage the signed-in user's Supabase MFA factors. */
export function TwoFactorSection() {
  const { user, refreshMfaStatus } = useAuth();
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phoneUnavailable, setPhoneUnavailable] = useState(false);
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFactors(await listMfaFactors());
    } catch (err) {
      setError(describeMfaError(err, 'Could not load your verification methods.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const verified = factors.filter((f) => f.status === 'verified');
  const enabled = verified.length > 0;

  const audit = (action: string, details: Record<string, unknown>) => {
    if (!user) return;
    void logAudit({ userId: user.id, action, entityType: 'user', entityId: user.id, afterState: details }).catch(() => undefined);
  };

  const afterChange = async (message: string) => {
    setModal(null);
    setNotice(message);
    setTimeout(() => setNotice(null), 4000);
    await Promise.all([load(), refreshMfaStatus()]);
  };

  return (
    <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-hud-gold-soft" />
            Two-Factor Authentication
          </h3>
          <p className="text-sm text-hud-cream-dim mt-1">
            Require a one-time code from your phone in addition to your password when you sign in.
          </p>
        </div>
        {!isLoading && (
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
              enabled
                ? 'bg-hud-emerald/10 text-hud-emerald border-hud-emerald/20'
                : 'bg-hud-bg-card text-hud-cream-dim border-hud-bg-elev'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-hud-emerald' : 'bg-hud-cream-mute'}`} />
            {enabled ? 'Enabled' : 'Not enabled'}
          </span>
        )}
      </div>

      {notice && (
        <div className="flex items-center gap-2 p-3 mb-4 rounded-lg bg-hud-emerald/10 border border-hud-emerald/20 text-hud-emerald text-sm">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          {notice}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 rounded-lg bg-hud-plum/10 border border-hud-plum/20 text-hud-plum text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-6 h-6 text-hud-gold-soft animate-spin" />
        </div>
      ) : (
        <>
          {verified.length > 0 && (
            <ul className="space-y-3 mb-5">
              {verified.map((f) => {
                const Icon = f.factorType === 'totp' ? Smartphone : MessageSquare;
                return (
                  <li
                    key={f.id}
                    className="flex items-center justify-between gap-3 p-4 rounded-lg bg-hud-bg-card/50 border border-hud-bg-elev"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2 rounded-lg bg-hud-bg-elev">
                        <Icon className="w-5 h-5 text-hud-cream-soft" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate">{f.friendlyName}</p>
                        <p className="text-xs text-hud-cream-dim mt-0.5">
                          {f.factorType === 'totp' ? 'Authenticator app' : `SMS${f.phone ? ` to ${maskPhone(f.phone)}` : ''}`}
                          {' · '}Added {new Date(f.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setModal({ kind: 'remove', factor: f })}
                      className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-hud-plum hover:bg-hud-plum/10 border border-transparent hover:border-hud-plum/20"
                    >
                      <Trash2 className="w-4 h-4" />
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {phoneUnavailable && (
            <div className="flex items-start gap-2 p-3 mb-4 rounded-lg bg-hud-rust/10 border border-hud-rust/20 text-hud-rust text-sm">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {PHONE_MFA_DISABLED_MESSAGE}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setModal({ kind: 'totp' })}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white text-sm font-medium hover:from-hud-gold-deep hover:to-hud-teal"
            >
              <Plus className="w-4 h-4" />
              Add authenticator app
            </button>
            <button
              type="button"
              onClick={() => setModal({ kind: 'sms' })}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm font-medium hover:border-hud-gold"
            >
              <Plus className="w-4 h-4" />
              Add SMS
            </button>
          </div>

          {!enabled && (
            <p className="text-xs text-hud-cream-mute mt-4">
              Once a method is added you'll be asked for a code each time you sign in. Adding a second method keeps you in
              if you lose your phone.
            </p>
          )}
        </>
      )}

      {modal?.kind === 'totp' && (
        <TotpEnrollModal
          onClose={() => setModal(null)}
          onEnrolled={async (name) => {
            audit('mfa_factor_enrolled', { factor_type: 'totp', friendly_name: name });
            await afterChange('Authenticator app added. You will be asked for a code at sign-in.');
          }}
        />
      )}

      {modal?.kind === 'sms' && (
        <SmsEnrollModal
          defaultPhone={user?.phone ?? null}
          onClose={() => setModal(null)}
          onPhoneMfaUnavailable={() => setPhoneUnavailable(true)}
          onEnrolled={async (name) => {
            audit('mfa_factor_enrolled', { factor_type: 'phone', friendly_name: name });
            await afterChange('SMS verification added. You will be asked for a code at sign-in.');
          }}
        />
      )}

      {modal?.kind === 'remove' && (
        <RemoveFactorModal
          target={modal.factor}
          verifiedFactors={verified}
          onClose={() => setModal(null)}
          onRemoved={async () => {
            audit('mfa_factor_removed', { factor_type: modal.factor.factorType, friendly_name: modal.factor.friendlyName });
            await afterChange(
              verified.length <= 1
                ? 'Verification method removed. Two-factor authentication is now off.'
                : 'Verification method removed.',
            );
          }}
        />
      )}
    </div>
  );
}
