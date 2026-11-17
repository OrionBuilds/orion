import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getRecurringProfiles,
  getRecurringProfileStats,
  pauseRecurringProfile,
  resumeRecurringProfile,
  cancelRecurringProfile,
  type RecurringProfile,
  type RecurringProfileStats,
} from '../../services/recurringProfiles';
import {
  RefreshCw,
  Plus,
  Search,
  MoreVertical,
  Pause,
  Play,
  XCircle,
  Eye,
  Loader2,
  TrendingUp,
  Calendar,
  DollarSign,
  Users,
} from 'lucide-react';
import { CreateRecurringProfileModal } from './CreateRecurringProfileModal';
import { formatCurrency, formatDateNumeric } from '../../utils/formatters';
import { Portal } from '../shared/Portal';
import { AnchoredMenu } from '../shared/AnchoredMenu';

interface Props {
  onRefresh?: () => void;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  active: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', label: 'Active' },
  paused: { bg: 'bg-hud-rust/20', text: 'text-hud-rust/40', label: 'Paused' },
  cancelled: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', label: 'Cancelled' },
};

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
};

export function RecurringProfilesTab({ onRefresh }: Props) {
  const { user, hasPermission } = useAuth();
  const [profiles, setProfiles] = useState<RecurringProfile[]>([]);
  const [stats, setStats] = useState<RecurringProfileStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<RecurringProfile | null>(null);

  const canManage = hasPermission('payments.manage');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setIsLoading(true);
      const [profilesData, statsData] = await Promise.all([
        getRecurringProfiles(),
        getRecurringProfileStats(),
      ]);
      setProfiles(profilesData);
      setStats(statsData);
    } catch (err) {
      console.error('Failed to load recurring profiles:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePause = async (profile: RecurringProfile) => {
    if (!user) return;
    try {
      await pauseRecurringProfile(profile.id, user);
      loadData();
    } catch (err) {
      console.error('Failed to pause profile:', err);
    }
    setActionMenuId(null);
  };

  const handleResume = async (profile: RecurringProfile) => {
    if (!user) return;
    try {
      await resumeRecurringProfile(profile.id, user);
      loadData();
    } catch (err) {
      console.error('Failed to resume profile:', err);
    }
    setActionMenuId(null);
  };

  const handleCancel = async (profile: RecurringProfile) => {
    if (!user || !confirm('Are you sure you want to cancel this recurring profile? This cannot be undone.')) return;
    try {
      await cancelRecurringProfile(profile.id, user);
      loadData();
    } catch (err) {
      console.error('Failed to cancel profile:', err);
    }
    setActionMenuId(null);
  };

  const getContactName = (profile: RecurringProfile) => {
    if (!profile.contact) return 'Unknown';
    return profile.contact.company || `${profile.contact.first_name} ${profile.contact.last_name}`;
  };

  const calculateProfileTotal = (profile: RecurringProfile) => {
    return (profile.items || []).reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
  };

  const filteredProfiles = profiles.filter((profile) => {
    if (statusFilter !== 'all' && profile.status !== statusFilter) return false;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const contactName = getContactName(profile).toLowerCase();
      const profileName = profile.name.toLowerCase();
      if (!contactName.includes(query) && !profileName.includes(query)) return false;
    }
    return true;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev/50 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-gold/10">
                <Users className="w-5 h-5 text-hud-gold-soft" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-white">{stats.activeProfiles}</p>
                <p className="text-sm text-hud-cream-dim">Active Profiles</p>
              </div>
            </div>
          </div>
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev/50 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-emerald/10">
                <DollarSign className="w-5 h-5 text-hud-emerald" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-white">{formatCurrency(stats.monthlyRecurringRevenue)}</p>
                <p className="text-sm text-hud-cream-dim">Monthly Revenue</p>
              </div>
            </div>
          </div>
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev/50 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-teal/10">
                <TrendingUp className="w-5 h-5 text-hud-teal" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-white">{formatCurrency(stats.annualRecurringRevenue)}</p>
                <p className="text-sm text-hud-cream-dim">Annual Revenue</p>
              </div>
            </div>
          </div>
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev/50 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-rust/10">
                <Pause className="w-5 h-5 text-hud-rust" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-white">{stats.pausedProfiles}</p>
                <p className="text-sm text-hud-cream-dim">Paused</p>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
            <input
              type="text"
              placeholder="Search profiles..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        {canManage && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-hud-emerald to-hud-teal text-white font-medium hover:from-hud-emerald-dim hover:to-hud-teal transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Profile
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-hud-bg-mid sticky top-0 z-10">
            <tr className="border-b border-hud-bg-card">
              <th className="text-left py-3 px-4 text-sm font-medium text-hud-cream-dim">Profile</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-hud-cream-dim">Contact</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-hud-cream-dim">Amount</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-hud-cream-dim">Frequency</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-hud-cream-dim">Status</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-hud-cream-dim">Next Invoice</th>
              <th className="text-right py-3 px-4 text-sm font-medium text-hud-cream-dim">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredProfiles.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-hud-cream-dim">
                  <RefreshCw className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No recurring profiles found</p>
                  {canManage && (
                    <button
                      onClick={() => setShowCreateModal(true)}
                      className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      Create your first profile
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              filteredProfiles.map((profile) => {
                const statusStyle = STATUS_STYLES[profile.status] || STATUS_STYLES.active;
                const total = calculateProfileTotal(profile);
                return (
                  <tr
                    key={profile.id}
                    className="border-b border-hud-bg-card/50 hover:bg-hud-bg-card/30 cursor-pointer"
                    onClick={() => setSelectedProfile(profile)}
                  >
                    <td className="py-3 px-4">
                      <div>
                        <span className="text-white font-medium">{profile.name}</span>
                        <div className="flex items-center gap-1 text-hud-cream-dim text-xs mt-0.5">
                          <Calendar className="w-3 h-3" />
                          Created {formatDateNumeric(profile.created_at)}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-white">{getContactName(profile)}</span>
                      {profile.contact?.email && (
                        <p className="text-hud-cream-dim text-xs">{profile.contact.email}</p>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-white font-medium">{formatCurrency(total)}</span>
                      <p className="text-hud-cream-dim text-xs">per {profile.frequency.replace('ly', '')}</p>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-hud-cream-soft">{FREQUENCY_LABELS[profile.frequency]}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                        {statusStyle.label}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-hud-cream-soft">
                        {profile.next_invoice_date ? formatDateNumeric(profile.next_invoice_date) : '-'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="relative">
                        <button
                          onClick={() => setActionMenuId(actionMenuId === profile.id ? null : profile.id)}
                          className="p-1.5 rounded hover:bg-hud-bg-elev text-hud-cream-dim"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>
                        {actionMenuId === profile.id && (
                          <AnchoredMenu className="w-48 rounded-lg bg-hud-bg-card border border-hud-bg-elev shadow-xl z-50">
                            <button
                              onClick={() => {
                                setSelectedProfile(profile);
                                setActionMenuId(null);
                              }}
                              className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                            >
                              <Eye className="w-4 h-4" />
                              View Details
                            </button>
                            {profile.status === 'active' && canManage && (
                              <button
                                onClick={() => handlePause(profile)}
                                className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                              >
                                <Pause className="w-4 h-4" />
                                Pause Profile
                              </button>
                            )}
                            {profile.status === 'paused' && canManage && (
                              <button
                                onClick={() => handleResume(profile)}
                                className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                              >
                                <Play className="w-4 h-4" />
                                Resume Profile
                              </button>
                            )}
                            {profile.status !== 'cancelled' && canManage && (
                              <button
                                onClick={() => handleCancel(profile)}
                                className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-hud-plum hover:bg-hud-bg-elev"
                              >
                                <XCircle className="w-4 h-4" />
                                Cancel Profile
                              </button>
                            )}
                          </AnchoredMenu>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showCreateModal && (
        <CreateRecurringProfileModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            loadData();
            onRefresh?.();
          }}
        />
      )}

      {selectedProfile && (
        <RecurringProfileDetailModal
          profile={selectedProfile}
          onClose={() => setSelectedProfile(null)}
          onUpdated={loadData}
        />
      )}
    </div>
  );
}

function RecurringProfileDetailModal({
  profile,
  onClose,
  onUpdated,
}: {
  profile: RecurringProfile;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission('payments.manage');
  const statusStyle = STATUS_STYLES[profile.status] || STATUS_STYLES.active;

  const handlePause = async () => {
    if (!user) return;
    try {
      await pauseRecurringProfile(profile.id, user);
      onUpdated();
      onClose();
    } catch (err) {
      console.error('Failed to pause profile:', err);
    }
  };

  const handleResume = async () => {
    if (!user) return;
    try {
      await resumeRecurringProfile(profile.id, user);
      onUpdated();
      onClose();
    } catch (err) {
      console.error('Failed to resume profile:', err);
    }
  };

  const handleCancel = async () => {
    if (!user || !confirm('Are you sure you want to cancel this recurring profile?')) return;
    try {
      await cancelRecurringProfile(profile.id, user);
      onUpdated();
      onClose();
    } catch (err) {
      console.error('Failed to cancel profile:', err);
    }
  };

  const total = (profile.items || []).reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card w-full max-w-2xl max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-hud-bg-card">
          <div>
            <h2 className="text-xl font-semibold text-white">{profile.name}</h2>
            <p className="text-hud-cream-dim text-sm mt-1">Recurring Profile Details</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-hud-bg-card text-hud-cream-dim hover:text-white transition-colors"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-hud-bg-card/50 rounded-lg p-4">
              <p className="text-hud-cream-dim text-sm">Status</p>
              <span className={`inline-flex mt-1 px-2 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                {statusStyle.label}
              </span>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4">
              <p className="text-hud-cream-dim text-sm">Frequency</p>
              <p className="text-white font-medium mt-1">{FREQUENCY_LABELS[profile.frequency]}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4">
              <p className="text-hud-cream-dim text-sm">Amount per Cycle</p>
              <p className="text-white font-medium mt-1">{formatCurrency(total)}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4">
              <p className="text-hud-cream-dim text-sm">Next Invoice</p>
              <p className="text-white font-medium mt-1">{formatDateNumeric(profile.next_invoice_date)}</p>
            </div>
          </div>

          <div className="bg-hud-bg-card/50 rounded-lg p-4">
            <p className="text-hud-cream-dim text-sm mb-2">Contact</p>
            <p className="text-white font-medium">
              {profile.contact?.company || `${profile.contact?.first_name} ${profile.contact?.last_name}`}
            </p>
            {profile.contact?.email && (
              <p className="text-hud-cream-dim text-sm">{profile.contact.email}</p>
            )}
          </div>

          <div>
            <p className="text-hud-cream-dim text-sm mb-3">Line Items</p>
            <div className="bg-hud-bg-card/50 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-hud-bg-elev">
                    <th className="text-left py-2 px-4 text-xs font-medium text-hud-cream-dim">Description</th>
                    <th className="text-right py-2 px-4 text-xs font-medium text-hud-cream-dim">Qty</th>
                    <th className="text-right py-2 px-4 text-xs font-medium text-hud-cream-dim">Price</th>
                    <th className="text-right py-2 px-4 text-xs font-medium text-hud-cream-dim">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(profile.items || []).map((item) => (
                    <tr key={item.id} className="border-b border-hud-bg-elev/50">
                      <td className="py-2 px-4 text-white text-sm">{item.description}</td>
                      <td className="py-2 px-4 text-hud-cream-soft text-sm text-right">{item.quantity}</td>
                      <td className="py-2 px-4 text-hud-cream-soft text-sm text-right">{formatCurrency(item.unit_price)}</td>
                      <td className="py-2 px-4 text-white text-sm text-right font-medium">{formatCurrency(item.quantity * item.unit_price)}</td>
                    </tr>
                  ))}
                  <tr className="bg-hud-bg-elev/30">
                    <td colSpan={3} className="py-2 px-4 text-white text-sm font-medium text-right">Total</td>
                    <td className="py-2 px-4 text-white text-sm text-right font-bold">{formatCurrency(total)}</td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-hud-cream-dim">Auto-send Invoices</p>
              <p className="text-white">{profile.auto_send ? 'Yes' : 'No'}</p>
            </div>
            <div>
              <p className="text-hud-cream-dim">End Date</p>
              <p className="text-white">{formatDateNumeric(profile.end_date)}</p>
            </div>
            <div>
              <p className="text-hud-cream-dim">Created</p>
              <p className="text-white">{formatDateNumeric(profile.created_at)}</p>
            </div>
            <div>
              <p className="text-hud-cream-dim">Last Updated</p>
              <p className="text-white">{formatDateNumeric(profile.updated_at)}</p>
            </div>
          </div>
        </div>

        {canManage && profile.status !== 'cancelled' && (
          <div className="flex items-center justify-end gap-3 p-6 border-t border-hud-bg-card">
            {profile.status === 'active' && (
              <button
                onClick={handlePause}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-rust/10 text-hud-rust hover:bg-hud-rust/20 transition-colors"
              >
                <Pause className="w-4 h-4" />
                Pause
              </button>
            )}
            {profile.status === 'paused' && (
              <button
                onClick={handleResume}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-emerald/10 text-hud-emerald hover:bg-hud-emerald/20 transition-colors"
              >
                <Play className="w-4 h-4" />
                Resume
              </button>
            )}
            <button
              onClick={handleCancel}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-plum/10 text-hud-plum hover:bg-hud-plum/20 transition-colors"
            >
              <XCircle className="w-4 h-4" />
              Cancel Profile
            </button>
          </div>
        )}
      </div>
    </div></Portal>
  );
}
