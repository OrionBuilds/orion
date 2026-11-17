import { useState, useEffect } from 'react';
import {
  User as UserIcon,
  Mail,
  Phone,
  Calendar,
  Clock,
  Shield,
  Building2,
  AlertCircle,
  Save,
  Loader2,
  MoreVertical,
  KeyRound,
  UserX,
  UserCheck,
  Send,
  Activity,
  RotateCcw,
  ShieldOff,
  Smartphone,
} from 'lucide-react';
import { SlideInDrawer } from '../../ui/SlideInDrawer';
import { RoleBadge } from './RoleBadge';
import { PermissionMatrix } from './PermissionMatrix';
import { useAuth } from '../../../contexts/AuthContext';
import {
  updateUser,
  disableUser,
  enableUser,
  resetUserPassword,
  resendInvite,
  getUserActivity,
} from '../../../services/users';
import { adminGetUserMfaStatus, adminResetUserMfa, type AdminMfaFactorSummary } from '../../../services/mfa';
import type { User, Department, Role, AuditLog } from '../../../types';
import { Portal } from '../../shared/Portal';
import { AnchoredMenu } from '../../shared/AnchoredMenu';

interface UserDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  member: User | null;
  departments: Department[];
  roles: Role[];
  onUpdate: () => void;
}

type Tab = 'profile' | 'permissions' | 'activity';

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export function UserDetailDrawer({
  isOpen,
  onClose,
  member,
  departments,
  roles,
  onUpdate,
}: UserDetailDrawerProps) {
  const { user, isSuperAdmin, hasPermission } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('profile');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [showConfirmDisable, setShowConfirmDisable] = useState(false);
  const [showConfirmReset, setShowConfirmReset] = useState(false);
  const [showConfirmMfaReset, setShowConfirmMfaReset] = useState(false);
  const [mfaFactors, setMfaFactors] = useState<AdminMfaFactorSummary[] | null>(null);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [activityLogs, setActivityLogs] = useState<AuditLog[]>([]);
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    role_id: '',
    department_id: null as string | null,
    phone: '',
    timezone: '',
  });

  useEffect(() => {
    if (member && isOpen) {
      setFormData({
        name: member.name,
        role_id: member.role_id,
        department_id: member.department_id,
        phone: member.phone || '',
        timezone: member.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setActiveTab('profile');
      setError(null);
      setSuccess(null);
    }
  }, [member, isOpen]);

  useEffect(() => {
    if (activeTab === 'activity' && member) {
      loadActivity();
    }
  }, [activeTab, member]);

  // Two-factor status is only readable with the service role, so it comes from the admin edge
  // function, which re-checks permission, org and role rank. Only asked for when this viewer could
  // act on it.
  const canManageMfa =
    !!member &&
    member.id !== user?.id &&
    (isSuperAdmin ||
      (hasPermission('staff.reset_password') &&
        (member.role?.hierarchy_level ?? 999) > (user?.role?.hierarchy_level ?? 999)));
  useEffect(() => {
    if (!isOpen || !member || !canManageMfa) {
      setMfaFactors(null);
      setMfaError(null);
      return;
    }
    let cancelled = false;
    setMfaFactors(null);
    setMfaError(null);
    adminGetUserMfaStatus(member.id)
      .then((factors) => { if (!cancelled) setMfaFactors(factors); })
      .catch((err) => { if (!cancelled) setMfaError(err instanceof Error ? err.message : 'Unavailable'); });
    return () => { cancelled = true; };
  }, [isOpen, member, canManageMfa]);

  const loadActivity = async () => {
    if (!member) return;
    setIsLoadingActivity(true);
    try {
      const logs = await getUserActivity(member.id, { limit: 50 });
      // REAL BUG FIX: getUserActivity returns { data, count }, not an array — storing the wrapper
      // object made the Activity tab's `activityLogs.map` throw. Unwrap the rows.
      setActivityLogs(logs.data || []);
    } catch (err) {
      console.error('Failed to load activity:', err);
    } finally {
      setIsLoadingActivity(false);
    }
  };

  const currentUserHierarchy = user?.role?.hierarchy_level ?? 999;
  const memberHierarchy = member?.role?.hierarchy_level ?? 999;

  const canManage = hasPermission('staff.manage') || isSuperAdmin;
  const canDisable = hasPermission('staff.disable') || isSuperAdmin;
  const canResetPassword = hasPermission('staff.reset_password') || isSuperAdmin;
  const isAdmin = user?.role?.name === 'Admin' || isSuperAdmin;
  const isManager = user?.role?.name === 'Manager';

  const canEditRole = isSuperAdmin || (canManage && memberHierarchy > currentUserHierarchy);
  const canEditPermissions = isAdmin && !isManager;

  const availableRoles = roles.filter((role) => {
    if (isSuperAdmin) return true;
    return role.hierarchy_level > currentUserHierarchy;
  });

  const isOwnProfile = member?.id === user?.id;

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'active':
        return {
          color: 'bg-hud-emerald/10 text-hud-emerald border-hud-emerald/20',
          label: 'Active',
        };
      case 'disabled':
        return { color: 'bg-hud-plum/10 text-hud-plum border-hud-plum/20', label: 'Disabled' };
      case 'invited':
        return { color: 'bg-hud-rust/10 text-hud-rust border-hud-rust/20', label: 'Invited' };
      default:
        return { color: 'bg-hud-cream-mute/10 text-hud-cream-dim border-hud-cream-mute/20', label: status };
    }
  };

  const handleSave = async () => {
    if (!user || !member || !canManage) return;
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);

    try {
      await updateUser(member.id, formData, user);
      setSuccess('User updated successfully');
      onUpdate();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDisable = async () => {
    if (!user || !member || !canDisable) return;
    setError(null);
    setIsSubmitting(true);

    try {
      await disableUser(member.id, user);
      setSuccess('User disabled');
      setShowConfirmDisable(false);
      onUpdate();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable user');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnable = async () => {
    if (!user || !member || !canDisable) return;
    setError(null);
    setIsSubmitting(true);

    try {
      await enableUser(member.id, user);
      setSuccess('User enabled');
      onUpdate();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable user');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetPassword = async () => {
    if (!user || !member || !canResetPassword) return;
    setError(null);
    setIsSubmitting(true);

    try {
      await resetUserPassword(member.id, user);
      setSuccess('Password reset email sent');
      setShowConfirmReset(false);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send password reset');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetMfa = async () => {
    if (!member || !canManageMfa) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const { removed } = await adminResetUserMfa(member.id);
      setShowConfirmMfaReset(false);
      setMfaFactors([]);
      setSuccess(
        removed > 0
          ? `Two-factor authentication reset (${removed} method${removed === 1 ? '' : 's'} removed). ${member.name} has been signed out and can sign in with their password.`
          : 'This user had no two-factor methods to remove.',
      );
      setTimeout(() => setSuccess(null), 6000);
    } catch (err) {
      setShowConfirmMfaReset(false);
      setError(err instanceof Error ? err.message : 'Failed to reset two-factor authentication');
    } finally {
      setIsSubmitting(false);
    }
  };

  const verifiedMfa = (mfaFactors ?? []).filter((f) => f.status === 'verified');
  const mfaSummary = verifiedMfa
    .map((f) => (f.factor_type === 'totp' ? 'Authenticator app' : `SMS${f.phone_masked ? ` ${f.phone_masked}` : ''}`))
    .join(', ');

  const handleResendInvite = async () => {
    if (!user || !member) return;
    setError(null);
    setIsSubmitting(true);

    try {
      await resendInvite(member.id, user);
      setSuccess('Invite resent successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend invite');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!member) return null;

  const statusConfig = getStatusConfig(member.status);

  const tabs = [
    { id: 'profile' as Tab, label: 'Profile', icon: UserIcon },
    { id: 'permissions' as Tab, label: 'Permissions', icon: Shield },
    { id: 'activity' as Tab, label: 'Activity', icon: Activity },
  ];

  const renderHeader = () => (
    <div className="p-6 border-b border-hud-bg-card">
      <div className="flex items-start gap-4">
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-white text-xl font-semibold flex-shrink-0">
          {member.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-xl font-semibold text-white">{member.name}</h3>
            {isOwnProfile && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-hud-gold/10 text-hud-gold-soft border border-hud-gold/20">
                You
              </span>
            )}
          </div>
          <p className="text-hud-cream-dim mt-0.5">{member.email}</p>
          <div className="flex items-center gap-2 mt-2">
            <span className={`text-xs px-2 py-1 rounded-full border ${statusConfig.color}`}>
              {statusConfig.label}
            </span>
            <RoleBadge roleName={member.role?.name || 'Unknown'} />
          </div>
        </div>

        {(canDisable || canResetPassword || canManageMfa) && (
          <div className="relative">
            <button
              onClick={() => setShowActions(!showActions)}
              className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
            >
              <MoreVertical className="w-5 h-5 text-hud-cream-dim" />
            </button>
            {showActions && (
              <AnchoredMenu className="w-48 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50">
                {member.status === 'invited' && (
                  <button
                    onClick={() => {
                      setShowActions(false);
                      handleResendInvite();
                    }}
                    disabled={isSubmitting}
                    className="w-full px-4 py-2.5 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev flex items-center gap-2 disabled:opacity-50"
                  >
                    <Send className="w-4 h-4" />
                    Resend Invite
                  </button>
                )}
                {canResetPassword && member.status === 'active' && (
                  <button
                    onClick={() => {
                      setShowActions(false);
                      setShowConfirmReset(true);
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev flex items-center gap-2"
                  >
                    <KeyRound className="w-4 h-4" />
                    Reset Password
                  </button>
                )}
                {canManageMfa && (
                  <button
                    onClick={() => {
                      setShowActions(false);
                      setShowConfirmMfaReset(true);
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev flex items-center gap-2"
                  >
                    <ShieldOff className="w-4 h-4" />
                    Reset Two-Factor
                  </button>
                )}
                {canDisable && !isOwnProfile && (
                  <>
                    <div className="border-t border-hud-bg-elev my-1" />
                    {member.status === 'disabled' ? (
                      <button
                        onClick={() => {
                          setShowActions(false);
                          handleEnable();
                        }}
                        disabled={isSubmitting}
                        className="w-full px-4 py-2.5 text-left text-sm text-hud-emerald hover:bg-hud-bg-elev flex items-center gap-2 disabled:opacity-50"
                      >
                        <UserCheck className="w-4 h-4" />
                        Enable User
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setShowActions(false);
                          setShowConfirmDisable(true);
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm text-hud-plum hover:bg-hud-bg-elev flex items-center gap-2"
                      >
                        <UserX className="w-4 h-4" />
                        Disable User
                      </button>
                    )}
                  </>
                )}
              </AnchoredMenu>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-1 mt-4 border-b border-hud-bg-card -mx-6 px-6">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                activeTab === tab.id
                  ? 'text-hud-gold-soft border-hud-gold-soft'
                  : 'text-hud-cream-dim border-transparent hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderProfileTab = () => (
    <div className="p-6 space-y-6">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20">
          <AlertCircle className="w-5 h-5 text-hud-plum flex-shrink-0" />
          <p className="text-sm text-hud-plum">{error}</p>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-emerald/10 border border-hud-emerald/20">
          <AlertCircle className="w-5 h-5 text-hud-emerald flex-shrink-0" />
          <p className="text-sm text-hud-emerald">{success}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-hud-bg-card/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <UserIcon className="w-4 h-4 text-hud-gold-soft" />
            <span className="text-sm font-medium text-hud-cream-soft">Name</span>
          </div>
          {canManage ? (
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="text-white bg-transparent w-full focus:outline-none border-b border-transparent hover:border-hud-cream-mute focus:border-hud-gold pb-1"
            />
          ) : (
            <p className="text-white">{member.name}</p>
          )}
        </div>

        <div className="bg-hud-bg-card/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Mail className="w-4 h-4 text-hud-gold-soft" />
            <span className="text-sm font-medium text-hud-cream-soft">Email</span>
          </div>
          <p className="text-white">{member.email}</p>
          <p className="text-xs text-hud-cream-mute mt-1">Email cannot be changed</p>
        </div>

        <div className="bg-hud-bg-card/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Phone className="w-4 h-4 text-hud-gold-soft" />
            <span className="text-sm font-medium text-hud-cream-soft">Phone</span>
          </div>
          {canManage ? (
            <input
              type="tel"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              placeholder="Not provided"
              className="text-white bg-transparent w-full focus:outline-none border-b border-transparent hover:border-hud-cream-mute focus:border-hud-gold pb-1 placeholder-hud-cream-dim"
            />
          ) : (
            <p className="text-white">{member.phone || 'Not provided'}</p>
          )}
        </div>

        <div className="bg-hud-bg-card/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-4 h-4 text-hud-gold-soft" />
            <span className="text-sm font-medium text-hud-cream-soft">Role</span>
          </div>
          {canEditRole ? (
            <select
              value={formData.role_id}
              onChange={(e) => setFormData({ ...formData, role_id: e.target.value })}
              className="text-white bg-hud-bg-elev rounded px-2 py-1 w-full focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              {member.role && !availableRoles.find((r) => r.id === member.role_id) && (
                <option value={member.role_id}>{member.role.name}</option>
              )}
              {availableRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-white">{member.role?.name || 'Unknown'}</p>
          )}
        </div>

        <div className="bg-hud-bg-card/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Building2 className="w-4 h-4 text-hud-gold-soft" />
            <span className="text-sm font-medium text-hud-cream-soft">Department</span>
          </div>
          {canManage ? (
            <select
              value={formData.department_id || ''}
              onChange={(e) =>
                setFormData({ ...formData, department_id: e.target.value || null })
              }
              className="text-white bg-hud-bg-elev rounded px-2 py-1 w-full focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="">No Department</option>
              {departments.map((dept) => (
                <option key={dept.id} value={dept.id}>
                  {dept.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-white">{member.department?.name || 'No Department'}</p>
          )}
        </div>

        <div className="bg-hud-bg-card/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-hud-gold-soft" />
            <span className="text-sm font-medium text-hud-cream-soft">Timezone</span>
          </div>
          {canManage ? (
            <select
              value={formData.timezone}
              onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
              className="text-white bg-hud-bg-elev rounded px-2 py-1 w-full focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-white">{member.timezone?.replace(/_/g, ' ') || 'Not set'}</p>
          )}
        </div>

        <div className="bg-hud-bg-card/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-4 h-4 text-hud-gold-soft" />
            <span className="text-sm font-medium text-hud-cream-soft">Joined</span>
          </div>
          <p className="text-white">
            {new Date(member.created_at).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        </div>

        <div className="bg-hud-bg-card/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-hud-gold-soft" />
            <span className="text-sm font-medium text-hud-cream-soft">Last Active</span>
          </div>
          <p className="text-white">
            {member.last_sign_in_at
              ? new Date(member.last_sign_in_at).toLocaleString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'Never'}
          </p>
        </div>

        {canManageMfa && (
          <div className="bg-hud-bg-card/50 rounded-lg p-4 md:col-span-2">
            <div className="flex items-center gap-2 mb-2">
              <Smartphone className="w-4 h-4 text-hud-gold-soft" />
              <span className="text-sm font-medium text-hud-cream-soft">Two-Factor Authentication</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {mfaError ? (
                <p className="text-sm text-hud-cream-dim">Status unavailable: {mfaError}</p>
              ) : mfaFactors === null ? (
                <Loader2 className="w-4 h-4 animate-spin text-hud-cream-dim" />
              ) : verifiedMfa.length > 0 ? (
                <p className="text-white text-sm">
                  <span className="text-hud-emerald font-medium">Enabled</span>
                  <span className="text-hud-cream-dim"> · {mfaSummary}</span>
                </p>
              ) : (
                <p className="text-sm text-hud-cream-dim">Not enabled</p>
              )}
              {verifiedMfa.length > 0 && (
                <button
                  onClick={() => setShowConfirmMfaReset(true)}
                  disabled={isSubmitting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-hud-rust border border-hud-rust/30 hover:bg-hud-rust/10 disabled:opacity-50"
                >
                  <ShieldOff className="w-4 h-4" />
                  Reset
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const renderPermissionsTab = () => (
    <div className="p-6">
      {!canEditPermissions && (
        <div className="mb-4 p-3 rounded-lg bg-hud-bg-card/50 border border-hud-bg-elev">
          <p className="text-sm text-hud-cream-dim">
            You can view this user's permissions but cannot modify them.
          </p>
        </div>
      )}
      <PermissionMatrix
        userId={member.id}
        roleId={member.role_id}
        canEdit={canEditPermissions}
        onUpdate={onUpdate}
      />
    </div>
  );

  const renderActivityTab = () => (
    <div className="p-6">
      {isLoadingActivity ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-hud-gold" />
        </div>
      ) : activityLogs.length === 0 ? (
        <div className="text-center py-12">
          <Activity className="w-12 h-12 text-hud-cream-mute mx-auto mb-3" />
          <p className="text-hud-cream-dim">No activity recorded</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-medium text-white">Recent Activity</h4>
            <button
              onClick={loadActivity}
              className="p-1.5 rounded hover:bg-hud-bg-card transition-colors"
            >
              <RotateCcw className="w-4 h-4 text-hud-cream-dim" />
            </button>
          </div>
          {activityLogs.map((log) => (
            <div
              key={log.id}
              className="flex items-start gap-3 p-3 rounded-lg bg-hud-bg-card/50 border border-hud-bg-card"
            >
              <div className="w-8 h-8 rounded-full bg-hud-bg-elev flex items-center justify-center flex-shrink-0">
                <Activity className="w-4 h-4 text-hud-cream-dim" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white">
                  <span className="font-medium">{log.action}</span>
                  {log.entity_type && (
                    <span className="text-hud-cream-dim"> on {log.entity_type}</span>
                  )}
                </p>
                <p className="text-xs text-hud-cream-mute mt-0.5">
                  {new Date(log.timestamp).toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const footer = canManage && activeTab === 'profile' ? (
    <div className="flex justify-end gap-3">
      <button
        onClick={onClose}
        className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors font-medium"
      >
        Cancel
      </button>
      <button
        onClick={handleSave}
        disabled={isSubmitting}
        className="px-4 py-2 rounded-lg bg-hud-gold-deep text-white hover:text-hud-bg-deep hover:bg-hud-gold transition-colors font-medium disabled:opacity-50 inline-flex items-center gap-2"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Saving...
          </>
        ) : (
          <>
            <Save className="w-4 h-4" />
            Save Changes
          </>
        )}
      </button>
    </div>
  ) : (
    <div className="flex justify-end">
      <button
        onClick={onClose}
        className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors font-medium"
      >
        Close
      </button>
    </div>
  );

  return (
    <>
      <SlideInDrawer isOpen={isOpen} onClose={onClose} footer={footer} width="xl">
        {renderHeader()}
        {activeTab === 'profile' && renderProfileTab()}
        {activeTab === 'permissions' && renderPermissionsTab()}
        {activeTab === 'activity' && renderActivityTab()}
      </SlideInDrawer>

      {showConfirmDisable && (
        <Portal><div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-white mb-2">Disable User</h3>
            <p className="text-hud-cream-dim mb-4">
              Are you sure you want to disable <strong>{member.name}</strong>? They will lose
              access immediately. Their sessions will be revoked. Historical data will be preserved.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirmDisable(false)}
                className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDisable}
                disabled={isSubmitting}
                className="px-4 py-2 rounded-lg bg-hud-plum text-white hover:bg-hud-plum transition-colors inline-flex items-center gap-2 disabled:opacity-50"
              >
                {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Disable User
              </button>
            </div>
          </div>
        </div></Portal>
      )}

      {showConfirmMfaReset && (
        <Portal><div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-white mb-2">Reset Two-Factor Authentication</h3>
            <p className="text-hud-cream-dim mb-3">
              This removes every two-factor method on <strong>{member.name}</strong>'s account and signs
              them out of all sessions. They can then sign in with their password alone and set up
              two-factor again from their Security settings.
            </p>
            <p className="text-sm text-hud-rust mb-4">
              Only do this after confirming the request really comes from {member.name} (for example by
              phone or in person). The reset is recorded in the audit log.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirmMfaReset(false)}
                className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleResetMfa}
                disabled={isSubmitting}
                className="px-4 py-2 rounded-lg bg-hud-rust text-white hover:bg-hud-rust transition-colors inline-flex items-center gap-2 disabled:opacity-50"
              >
                {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Reset Two-Factor
              </button>
            </div>
          </div>
        </div></Portal>
      )}

      {showConfirmReset && (
        <Portal><div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-white mb-2">Reset Password</h3>
            <p className="text-hud-cream-dim mb-4">
              A password reset email will be sent to <strong>{member.email}</strong>. They will
              need to click the link to set a new password.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirmReset(false)}
                className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleResetPassword}
                disabled={isSubmitting}
                className="px-4 py-2 rounded-lg bg-hud-gold-deep text-white hover:text-hud-bg-deep hover:bg-hud-gold transition-colors inline-flex items-center gap-2 disabled:opacity-50"
              >
                {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Send Reset Email
              </button>
            </div>
          </div>
        </div></Portal>
      )}
    </>
  );
}
