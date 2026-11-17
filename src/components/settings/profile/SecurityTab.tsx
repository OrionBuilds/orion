import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, Eye, EyeOff, Shield, Monitor, Globe, Check, X, AlertCircle } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { changePassword, verifyCurrentPassword, getUserSessions, type UserSession } from '../../../services/profile';
import { TwoFactorSection } from './mfa/TwoFactorSection';

interface PasswordRequirement {
  label: string;
  test: (password: string) => boolean;
}

const passwordRequirements: PasswordRequirement[] = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: 'Contains uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'Contains lowercase letter', test: (p) => /[a-z]/.test(p) },
  { label: 'Contains a number', test: (p) => /\d/.test(p) },
  { label: 'Contains special character', test: (p) => /[^a-zA-Z0-9]/.test(p) },
];

function SecuritySessionList({ userId }: { userId: string }) {
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadSessions() {
      try {
        const data = await getUserSessions(userId);
        setSessions(data);
      } catch (error) {
        console.error('Failed to load sessions:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadSessions();
  }, [userId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 text-hud-gold-soft animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="text-hud-cream-dim text-sm">No active sessions found.</p>
    );
  }

  return (
    <div className="space-y-3">
      {sessions.map((session) => (
        <div
          key={session.id}
          className="flex items-center justify-between p-4 rounded-lg bg-hud-bg-card/50 border border-hud-bg-elev"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-hud-bg-elev">
              <Monitor className="w-5 h-5 text-hud-cream-soft" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-white">{session.device}</p>
                {session.is_current && (
                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-hud-emerald/20 text-hud-emerald">
                    Current
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-hud-cream-dim mt-1">
                <Globe className="w-3 h-3" />
                <span>{session.ip_address}</span>
                <span>-</span>
                <span>Last active {new Date(session.last_active_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SecurityTab() {
  const { user } = useAuth();
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  const getPasswordStrength = (password: string): { strength: number; label: string; color: string } => {
    if (!password) return { strength: 0, label: '', color: '' };

    let strength = 0;
    if (password.length >= 8) strength++;
    if (password.length >= 12) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/\d/.test(password)) strength++;
    if (/[^a-zA-Z0-9]/.test(password)) strength++;

    if (strength <= 2) return { strength, label: 'Weak', color: 'text-hud-plum' };
    if (strength <= 3) return { strength, label: 'Fair', color: 'text-hud-rust' };
    if (strength === 4) return { strength, label: 'Good', color: 'text-hud-emerald' };
    return { strength, label: 'Strong', color: 'text-hud-emerald' };
  };

  const passwordStrength = getPasswordStrength(passwordData.newPassword);
  const passwordsMatch = passwordData.newPassword === passwordData.confirmPassword;
  const allRequirementsMet = passwordRequirements.every(req => req.test(passwordData.newPassword));

  const handleSave = async () => {
    setError(null);

    if (!user) return;

    if (!passwordsMatch) {
      setError('Passwords do not match');
      return;
    }

    if (!allRequirementsMet) {
      setError('Password does not meet all requirements');
      return;
    }

    setIsSaving(true);
    setSaveSuccess(false);

    try {
      const isValid = await verifyCurrentPassword(user.email, passwordData.currentPassword);
      if (!isValid) {
        setError('Current password is incorrect');
        setIsSaving(false);
        return;
      }

      await changePassword(passwordData.newPassword);
      setSaveSuccess(true);
      setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      console.error('Failed to change password:', err);
      setError(err.message || 'Failed to change password. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-6">
      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
        <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <Shield className="w-5 h-5 text-hud-gold-soft" />
          Change Password
        </h3>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                Current Password
              </label>
              <div className="relative">
                <input
                  type={showCurrentPassword ? 'text' : 'password'}
                  value={passwordData.currentPassword}
                  onChange={(e) => {
                    setPasswordData({ ...passwordData, currentPassword: e.target.value });
                    setError(null);
                  }}
                  className="w-full px-4 py-2 pr-10 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-hud-cream-dim hover:text-white"
                >
                  {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                New Password
              </label>
              <div className="relative">
                <input
                  type={showNewPassword ? 'text' : 'password'}
                  value={passwordData.newPassword}
                  onChange={(e) => {
                    setPasswordData({ ...passwordData, newPassword: e.target.value });
                    setError(null);
                  }}
                  className="w-full px-4 py-2 pr-10 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-hud-cream-dim hover:text-white"
                >
                  {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {passwordData.newPassword && (
                <div className="mt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="flex-1 h-1 bg-hud-bg-elev rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          passwordStrength.strength <= 2
                            ? 'bg-hud-plum'
                            : passwordStrength.strength === 3
                            ? 'bg-hud-rust'
                            : 'bg-hud-emerald'
                        }`}
                        style={{ width: `${(passwordStrength.strength / 5) * 100}%` }}
                      />
                    </div>
                    <span className={`text-xs font-medium ${passwordStrength.color}`}>
                      {passwordStrength.label}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                Confirm New Password
              </label>
              <div className="relative">
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={passwordData.confirmPassword}
                  onChange={(e) => {
                    setPasswordData({ ...passwordData, confirmPassword: e.target.value });
                    setError(null);
                  }}
                  className={`w-full px-4 py-2 pr-10 rounded-lg bg-hud-bg-card border text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent ${
                    passwordData.confirmPassword && !passwordsMatch
                      ? 'border-hud-plum'
                      : 'border-hud-bg-elev'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-hud-cream-dim hover:text-white"
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {passwordData.confirmPassword && !passwordsMatch && (
                <p className="text-xs text-hud-plum mt-1">Passwords do not match</p>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20 text-hud-plum">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            <button
              onClick={handleSave}
              disabled={
                isSaving ||
                !passwordData.currentPassword ||
                !passwordData.newPassword ||
                !passwordData.confirmPassword ||
                !passwordsMatch ||
                !allRequirementsMet
              }
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saveSuccess ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <Shield className="w-4 h-4" />
              )}
              {saveSuccess ? 'Password Changed' : 'Update Password'}
            </button>
          </div>

          <div className="lg:border-l lg:border-hud-bg-card lg:pl-6">
            <h4 className="text-sm font-medium text-hud-cream-soft mb-3">Password Requirements</h4>
            <ul className="space-y-2">
              {passwordRequirements.map((req, index) => {
                const isMet = passwordData.newPassword ? req.test(passwordData.newPassword) : false;
                return (
                  <li
                    key={index}
                    className={`flex items-center gap-2 text-sm ${
                      passwordData.newPassword
                        ? isMet
                          ? 'text-hud-emerald'
                          : 'text-hud-cream-dim'
                        : 'text-hud-cream-mute'
                    }`}
                  >
                    {passwordData.newPassword ? (
                      isMet ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <X className="w-4 h-4" />
                      )
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-hud-cream-mute" />
                    )}
                    {req.label}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>

      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
        <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <Monitor className="w-5 h-5 text-hud-gold-soft" />
          Active Sessions
        </h3>
        <p className="text-sm text-hud-cream-dim mb-4">
          Manage your active sessions. Your current session is shown below.
        </p>
        <SecuritySessionList userId={user.id} />
      </div>

      <TwoFactorSection />
    </div>
  );
}
