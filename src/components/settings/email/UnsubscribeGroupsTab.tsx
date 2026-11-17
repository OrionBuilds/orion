import { useState, useEffect } from 'react';
import { Plus, RefreshCw, Pencil, Trash2, X, Info } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  getUnsubscribeGroups,
  createUnsubscribeGroup,
  updateUnsubscribeGroup,
  setDefaultUnsubscribeGroup,
  deleteUnsubscribeGroup,
  syncUnsubscribeGroups,
} from '../../../services/emailUnsubscribeGroups';
import type { EmailUnsubscribeGroup } from '../../../types';
import { Portal } from '../../shared/Portal';

export function UnsubscribeGroupsTab() {
  const { user, hasPermission } = useAuth();
  const [groups, setGroups] = useState<EmailUnsubscribeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<EmailUnsubscribeGroup | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
  });

  const isAdmin = hasPermission('email.settings.manage');

  useEffect(() => {
    loadGroups();
  }, [user?.organization_id]);

  const loadGroups = async () => {
    if (!user?.organization_id) return;
    try {
      const data = await getUnsubscribeGroups(user.organization_id);
      setGroups(data);
    } catch (err) {
      console.error('Failed to load groups:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await syncUnsubscribeGroups();
      if (result.success) {
        await loadGroups();
      } else {
        setError(result.error || 'Failed to sync groups');
      }
    } catch (err) {
      setError('Failed to sync groups');
    } finally {
      setSyncing(false);
    }
  };

  const handleOpenModal = (group?: EmailUnsubscribeGroup) => {
    if (group) {
      setEditing(group);
      setFormData({
        name: group.name,
        description: group.description || '',
      });
    } else {
      setEditing(null);
      setFormData({ name: '', description: '' });
    }
    setShowModal(true);
    setError(null);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditing(null);
    setFormData({ name: '', description: '' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      if (editing) {
        const result = await updateUnsubscribeGroup(editing.id, {
          name: formData.name,
          description: formData.description || undefined,
        });
        if (!result.success) {
          setError(result.error || 'Failed to update');
          return;
        }
      } else {
        const result = await createUnsubscribeGroup(
          formData.name,
          formData.description || undefined
        );
        if (!result.success) {
          setError(result.error || 'Failed to create');
          return;
        }
      }
      handleCloseModal();
      await loadGroups();
    } catch (err) {
      setError('An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (groupId: string) => {
    try {
      await setDefaultUnsubscribeGroup(groupId);
      await loadGroups();
    } catch (err) {
      setError('Failed to set default');
    }
  };

  const handleDelete = async (groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (group?.is_default) {
      setError('Cannot delete the default unsubscribe group');
      return;
    }
    if (!confirm('Are you sure you want to delete this unsubscribe group?')) return;

    setDeleting(groupId);
    try {
      const result = await deleteUnsubscribeGroup(groupId);
      if (!result.success) {
        setError(result.error || 'Failed to delete');
      } else {
        await loadGroups();
      }
    } catch (err) {
      setError('Failed to delete');
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  return (
    <div>
      <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg">
        <div className="px-6 py-4 border-b border-hud-bg-elev flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium text-white">Unsubscribe Groups</h3>
            <p className="mt-1 text-sm text-hud-cream-dim">
              Manage email suppression groups for compliance with email regulations
            </p>
          </div>
          {isAdmin && (
            <div className="flex items-center space-x-2">
              <button
                onClick={handleSync}
                disabled={syncing}
                className="inline-flex items-center px-3 py-1.5 border border-hud-cream-mute text-sm font-medium rounded-md text-hud-cream-soft bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
                Refresh
              </button>
              <button
                onClick={() => handleOpenModal()}
                className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-white hover:text-hud-bg-deep bg-hud-gold-deep hover:bg-hud-gold"
              >
                <Plus className="h-4 w-4 mr-1.5" />
                Create Group
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="px-6 py-3 bg-hud-plum/10 border-b border-hud-plum/20">
            <p className="text-sm text-hud-plum">{error}</p>
          </div>
        )}

        {groups.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-hud-cream-dim">No unsubscribe groups configured</p>
            <p className="mt-2 text-sm text-hud-cream-mute">
              Create a group and set it as the default to add a one-click unsubscribe link to outgoing emails
            </p>
            {isAdmin && (
              <div className="mt-4 flex justify-center space-x-3">
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="inline-flex items-center px-4 py-2 border border-hud-cream-mute text-sm font-medium rounded-md text-hud-cream-soft bg-hud-bg-elev hover:bg-hud-cream-mute"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
                <button
                  onClick={() => handleOpenModal()}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white hover:text-hud-bg-deep bg-hud-gold-deep hover:bg-hud-gold"
                >
                  Create New Group
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-hud-bg-elev/50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Group Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Description
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Resend Tag
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Default
                  </th>
                  {isAdmin && (
                    <th className="px-6 py-3 text-right text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-hud-bg-elev">
                {groups.map((group) => (
                  <tr key={group.id}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-white">
                      {group.name}
                    </td>
                    <td className="px-6 py-4 text-sm text-hud-cream-dim max-w-xs truncate">
                      {group.description || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-hud-cream-mute font-mono">
                      {group.provider_group_id ?? '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <input
                        type="radio"
                        checked={group.is_default}
                        onChange={() => handleSetDefault(group.id)}
                        disabled={!isAdmin}
                        className="h-4 w-4 text-hud-gold-deep focus:ring-hud-gold border-hud-cream-mute bg-hud-bg-elev disabled:opacity-50"
                      />
                    </td>
                    {isAdmin && (
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => handleOpenModal(group)}
                          className="text-hud-gold-soft hover:text-hud-gold-soft mr-3"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(group.id)}
                          disabled={deleting === group.id || group.is_default}
                          className="text-hud-plum hover:text-hud-plum/40 disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-6 bg-hud-gold/5 border border-hud-gold/10 rounded-lg p-4">
        <div className="flex gap-3">
          <Info className="h-5 w-5 text-hud-gold-soft flex-shrink-0" />
          <div>
            <h4 className="text-sm font-medium text-hud-gold-soft">About Unsubscribe Groups</h4>
            <p className="mt-1 text-sm text-hud-cream-dim">
              When a default group is set, non-transactional emails sent through Resend (reports, meeting
              follow-ups, conversations, test emails, the scorecard) include a one-click List-Unsubscribe header
              and an unsubscribe footer link. Unsubscribed addresses are recorded as suppressions and skipped on
              future sends. Transactional emails (booking confirmations, sign-in codes, signature requests,
              receipts) are always delivered and carry no unsubscribe link. This supports CAN-SPAM and GDPR compliance.
            </p>
          </div>
        </div>
      </div>

      {showModal && (
        <Portal><div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-dvh items-end justify-center px-4 pt-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-black/60 transition-opacity" onClick={handleCloseModal} />
            <span className="hidden sm:inline-block sm:h-dvh sm:align-middle">&#8203;</span>
            <div className="inline-block transform overflow-hidden rounded-lg bg-hud-bg-card border border-hud-bg-elev px-4 pt-5 pb-4 text-left align-bottom shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6 sm:align-middle">
              <div className="absolute top-0 right-0 pt-4 pr-4">
                <button onClick={handleCloseModal} className="text-hud-cream-dim hover:text-hud-cream-soft">
                  <X className="h-6 w-6" />
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <h3 className="text-lg font-medium text-white mb-4">
                  {editing ? 'Edit Unsubscribe Group' : 'Create Unsubscribe Group'}
                </h3>

                {error && (
                  <div className="mb-4 p-3 bg-hud-plum/10 border border-hud-plum/20 rounded-md">
                    <p className="text-sm text-hud-plum">{error}</p>
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label htmlFor="name" className="block text-sm font-medium text-hud-cream-soft">
                      Group Name <span className="text-hud-plum">*</span>
                    </label>
                    <input
                      type="text"
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      required
                      placeholder="Marketing Emails"
                      className="mt-1 block w-full bg-hud-bg-mid border-hud-cream-mute rounded-md text-white placeholder-hud-cream-dim focus:ring-hud-gold focus:border-hud-gold sm:text-sm"
                    />
                  </div>

                  <div>
                    <label htmlFor="description" className="block text-sm font-medium text-hud-cream-soft">
                      Description
                    </label>
                    <textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      rows={3}
                      placeholder="Promotional emails, newsletters, and marketing updates"
                      className="mt-1 block w-full bg-hud-bg-mid border-hud-cream-mute rounded-md text-white placeholder-hud-cream-dim focus:ring-hud-gold focus:border-hud-gold sm:text-sm"
                    />
                    <p className="mt-1 text-xs text-hud-cream-mute">
                      This description is shown to users on the unsubscribe page
                    </p>
                  </div>
                </div>

                <div className="mt-6 flex justify-end space-x-3">
                  <button
                    type="button"
                    onClick={handleCloseModal}
                    className="px-4 py-2 border border-hud-cream-mute rounded-md text-sm font-medium text-hud-cream-soft bg-hud-bg-elev hover:bg-hud-cream-mute"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white hover:text-hud-bg-deep bg-hud-gold-deep hover:bg-hud-gold disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : editing ? 'Update' : 'Create Group'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div></Portal>
      )}
    </div>
  );
}
