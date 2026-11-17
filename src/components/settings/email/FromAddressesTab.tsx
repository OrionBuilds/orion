import { useState, useEffect } from 'react';
import { brandName } from '../../../lib/brands';
import { Plus, CheckCircle, Trash2, Pencil, X, RefreshCw } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getFromAddresses, createFromAddress, updateFromAddress, setDefaultFromAddress, deleteFromAddress, syncFromAddresses } from '../../../services/emailFromAddresses';
import { getDomains } from '../../../services/emailDomains';
import type { EmailFromAddress, EmailDomain } from '../../../types';
import { Portal } from '../../shared/Portal';

export function FromAddressesTab() {
  const { user, hasPermission } = useAuth();
  const [addresses, setAddresses] = useState<EmailFromAddress[]>([]);
  const [domains, setDomains] = useState<EmailDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<EmailFromAddress | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    displayName: '',
    email: '',
    domainId: '',
    replyTo: '',
  });

  const isAdmin = hasPermission('email.settings.manage');
  const verifiedDomains = domains.filter(d => d.status === 'verified');

  useEffect(() => {
    loadData();
  }, [user?.organization_id]);

  const loadData = async () => {
    if (!user?.organization_id) return;
    try {
      const [addressData, domainData] = await Promise.all([
        getFromAddresses(user.organization_id),
        getDomains(user.organization_id),
      ]);
      setAddresses(addressData);
      setDomains(domainData);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenModal = (address?: EmailFromAddress) => {
    if (address) {
      setEditing(address);
      setFormData({
        displayName: address.display_name,
        email: address.email,
        domainId: address.domain_id || '',
        replyTo: address.reply_to || '',
      });
    } else {
      setEditing(null);
      setFormData({
        displayName: '',
        email: '',
        domainId: verifiedDomains[0]?.id || '',
        replyTo: '',
      });
    }
    setShowModal(true);
    setError(null);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditing(null);
    setFormData({ displayName: '', email: '', domainId: '', replyTo: '' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      if (editing) {
        const result = await updateFromAddress(editing.id, {
          displayName: formData.displayName,
          replyTo: formData.replyTo || undefined,
        });
        if (!result.success) {
          setError(result.error || 'Failed to update');
          return;
        }
      } else {
        const result = await createFromAddress(
          formData.displayName,
          formData.email,
          formData.domainId,
          formData.replyTo || undefined
        );
        if (!result.success) {
          setError(result.error || 'Failed to create');
          return;
        }
      }
      handleCloseModal();
      await loadData();
    } catch (err) {
      setError('An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (addressId: string) => {
    try {
      await setDefaultFromAddress(addressId);
      await loadData();
    } catch (err) {
      setError('Failed to set default');
    }
  };

  const handleToggleActive = async (address: EmailFromAddress) => {
    try {
      await updateFromAddress(address.id, { active: !address.active });
      await loadData();
    } catch (err) {
      setError('Failed to update status');
    }
  };

  const handleDelete = async (addressId: string) => {
    const address = addresses.find(a => a.id === addressId);
    if (address?.is_default) {
      setError('Cannot delete the default from address');
      return;
    }
    if (!confirm('Are you sure you want to delete this from address?')) return;

    setDeleting(addressId);
    try {
      const result = await deleteFromAddress(addressId);
      if (!result.success) {
        setError(result.error || 'Failed to delete');
      } else {
        await loadData();
      }
    } catch (err) {
      setError('Failed to delete');
    } finally {
      setDeleting(null);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await syncFromAddresses();
      if (!result.success) {
        setError(result.error || 'Failed to sync');
      } else {
        await loadData();
      }
    } catch {
      setError('Failed to sync from addresses');
    } finally {
      setSyncing(false);
    }
  };

  const getSelectedDomain = () => {
    return verifiedDomains.find(d => d.id === formData.domainId);
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
          <h3 className="text-lg font-medium text-white">From Addresses</h3>
          {isAdmin && (
            <div className="flex items-center space-x-2">
              <button
                onClick={handleSync}
                disabled={syncing}
                className="inline-flex items-center px-3 py-1.5 border border-hud-cream-mute text-sm font-medium rounded-md text-hud-cream-soft bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing...' : 'Refresh'}
              </button>
              {verifiedDomains.length > 0 && (
                <button
                  onClick={() => handleOpenModal()}
                  className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-white hover:text-hud-bg-deep bg-hud-gold-deep hover:bg-hud-gold"
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  Add Address
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="px-6 py-3 bg-hud-plum/10 border-b border-hud-plum/20">
            <p className="text-sm text-hud-plum">{error}</p>
          </div>
        )}

        {verifiedDomains.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-hud-cream-dim">You need at least one verified domain before adding from addresses.</p>
          </div>
        ) : addresses.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-hud-cream-dim">No from addresses configured</p>
            {isAdmin && (
              <button
                onClick={() => handleOpenModal()}
                className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white hover:text-hud-bg-deep bg-hud-gold-deep hover:bg-hud-gold"
              >
                Add Your First Address
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-hud-bg-elev/50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Display Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Email Address
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Domain
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Brand
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Default
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Active
                  </th>
                  {isAdmin && (
                    <th className="px-6 py-3 text-right text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-hud-bg-elev">
                {addresses.map((address) => (
                  <tr key={address.id} className={!address.active ? 'bg-hud-bg-card/50' : ''}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-white">
                      {address.display_name}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-hud-cream-soft">
                      {address.email}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-hud-cream-dim">
                      <div className="flex items-center">
                        {address.domain?.domain || '-'}
                        {address.domain?.status === 'verified' && (
                          <CheckCircle className="h-4 w-4 ml-1 text-hud-emerald" />
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-hud-cream-dim">
                      {address.brand ? brandName(address.brand) : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <input
                        type="radio"
                        checked={address.is_default}
                        onChange={() => handleSetDefault(address.id)}
                        disabled={!isAdmin || !address.active}
                        className="h-4 w-4 text-hud-gold-deep focus:ring-hud-gold border-hud-cream-mute bg-hud-bg-elev disabled:opacity-50"
                      />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <button
                        onClick={() => handleToggleActive(address)}
                        disabled={!isAdmin || address.is_default}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-hud-gold focus:ring-offset-2 focus:ring-offset-hud-bg-card disabled:opacity-50 disabled:cursor-not-allowed ${
                          address.active ? 'bg-hud-gold-deep' : 'bg-hud-cream-mute'
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            address.active ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </td>
                    {isAdmin && (
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => handleOpenModal(address)}
                          className="text-hud-gold-soft hover:text-hud-gold-soft mr-3"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(address.id)}
                          disabled={deleting === address.id || address.is_default}
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
                  {editing ? 'Edit From Address' : 'Add From Address'}
                </h3>

                {error && (
                  <div className="mb-4 p-3 bg-hud-plum/10 border border-hud-plum/20 rounded-md">
                    <p className="text-sm text-hud-plum">{error}</p>
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label htmlFor="displayName" className="block text-sm font-medium text-hud-cream-soft">
                      Display Name <span className="text-hud-plum">*</span>
                    </label>
                    <input
                      type="text"
                      id="displayName"
                      value={formData.displayName}
                      onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                      required
                      placeholder="Your Company Name"
                      className="mt-1 block w-full bg-hud-bg-mid border-hud-cream-mute rounded-md text-white placeholder-hud-cream-dim focus:ring-hud-gold focus:border-hud-gold sm:text-sm"
                    />
                  </div>

                  {!editing && (
                    <>
                      <div>
                        <label htmlFor="domainId" className="block text-sm font-medium text-hud-cream-soft">
                          Domain <span className="text-hud-plum">*</span>
                        </label>
                        <select
                          id="domainId"
                          value={formData.domainId}
                          onChange={(e) => setFormData({ ...formData, domainId: e.target.value, email: '' })}
                          required
                          className="mt-1 block w-full bg-hud-bg-mid border-hud-cream-mute rounded-md text-white focus:ring-hud-gold focus:border-hud-gold sm:text-sm"
                        >
                          {verifiedDomains.map((domain) => (
                            <option key={domain.id} value={domain.id}>
                              {domain.domain}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor="email" className="block text-sm font-medium text-hud-cream-soft">
                          Email Address <span className="text-hud-plum">*</span>
                        </label>
                        <div className="mt-1 flex rounded-md shadow-sm">
                          <input
                            type="text"
                            id="email"
                            value={formData.email.split('@')[0] || ''}
                            onChange={(e) => {
                              const domain = getSelectedDomain();
                              setFormData({
                                ...formData,
                                email: `${e.target.value}@${domain?.domain || ''}`,
                              });
                            }}
                            required
                            placeholder="hello"
                            className="flex-1 block w-full rounded-none rounded-l-md bg-hud-bg-mid border-hud-cream-mute text-white placeholder-hud-cream-dim focus:ring-hud-gold focus:border-hud-gold sm:text-sm"
                          />
                          <span className="inline-flex items-center px-3 rounded-r-md border border-l-0 border-hud-cream-mute bg-hud-bg-elev text-hud-cream-dim sm:text-sm">
                            @{getSelectedDomain()?.domain || 'domain.com'}
                          </span>
                        </div>
                      </div>
                    </>
                  )}

                  <div>
                    <label htmlFor="replyTo" className="block text-sm font-medium text-hud-cream-soft">
                      Reply-To Address
                    </label>
                    <input
                      type="email"
                      id="replyTo"
                      value={formData.replyTo}
                      onChange={(e) => setFormData({ ...formData, replyTo: e.target.value })}
                      placeholder="replies@example.com"
                      className="mt-1 block w-full bg-hud-bg-mid border-hud-cream-mute rounded-md text-white placeholder-hud-cream-dim focus:ring-hud-gold focus:border-hud-gold sm:text-sm"
                    />
                    <p className="mt-1 text-xs text-hud-cream-mute">
                      Optional. Replies will go here instead of the from address.
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
                    {saving ? 'Saving...' : editing ? 'Update' : 'Add Address'}
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
