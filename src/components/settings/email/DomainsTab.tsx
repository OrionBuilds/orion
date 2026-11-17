import { useState, useEffect } from 'react';
import { Plus, CheckCircle, XCircle, Clock, RefreshCw, Trash2, Copy, ChevronRight, X } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getDomains, addDomain, verifyDomain, deleteDomain, syncDomains } from '../../../services/emailDomains';
import type { EmailDomain } from '../../../types';
import { Portal } from '../../shared/Portal';

export function DomainsTab() {
  const { user, hasPermission } = useAuth();
  const [domains, setDomains] = useState<EmailDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState<EmailDomain | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isAdmin = hasPermission('email.settings.manage');

  useEffect(() => {
    loadDomains();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.organization_id]);

  const loadDomains = async (): Promise<EmailDomain[]> => {
    if (!user?.organization_id) return [];
    try {
      const data = await getDomains(user.organization_id);
      setDomains(data);
      return data;
    } catch (err) {
      console.error('Failed to load domains:', err);
      setError(err instanceof Error ? err.message : 'Failed to load domains');
      return [];
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await syncDomains();
      if (!result.success) {
        setError(result.error || 'Failed to sync domains');
      } else {
        setNotice(`Synced ${result.synced ?? 0} domain${result.synced === 1 ? '' : 's'} from Resend`);
      }
      const fresh = await loadDomains();
      if (selectedDomain) setSelectedDomain(fresh.find(d => d.id === selectedDomain.id) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync domains');
    } finally {
      setSyncing(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      const result = await addDomain(newDomain);
      if (result.success) {
        setShowAddModal(false);
        setNewDomain('');
        await loadDomains();
        if (result.domain) {
          setSelectedDomain(result.domain);
        }
        setNotice('Domain added in Resend. Publish the DNS records below, then click Verify Now.');
      } else {
        setAddError(result.error || 'Failed to add domain');
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add domain');
    } finally {
      setAdding(false);
    }
  };

  const handleVerify = async (domainId: string) => {
    setVerifying(domainId);
    setError(null);
    setNotice(null);
    try {
      const result = await verifyDomain(domainId);
      const fresh = await loadDomains();
      const updated = result.domain ?? fresh.find(d => d.id === domainId);
      if (selectedDomain?.id === domainId && updated) setSelectedDomain(updated);
      if (!result.success) {
        setError(result.error || 'Failed to verify domain');
      } else if (result.valid) {
        setNotice('Domain verified.');
      } else {
        setNotice('Verification requested. Resend checks DNS in the background — DNS changes can take a while; check again shortly.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify domain');
    } finally {
      setVerifying(null);
    }
  };

  const handleDelete = async (domainId: string) => {
    if (!confirm('Remove this domain from the list? It stays registered in Resend (Sync will bring it back).')) return;
    setDeleting(domainId);
    try {
      const result = await deleteDomain(domainId);
      if (result.success) {
        if (selectedDomain?.id === domainId) {
          setSelectedDomain(null);
        }
        await loadDomains();
      } else {
        setError(result.error || 'Failed to delete domain');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete domain');
    } finally {
      setDeleting(null);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const getStatusBadge = (status: EmailDomain['status']) => {
    switch (status) {
      case 'verified':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-hud-emerald/10 text-hud-emerald border border-hud-emerald/20">
            <CheckCircle className="h-3 w-3 mr-1" />
            Verified
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-hud-plum/10 text-hud-plum border border-hud-plum/20">
            <XCircle className="h-3 w-3 mr-1" />
            Failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-hud-rust/10 text-hud-rust border border-hud-rust/20">
            <Clock className="h-3 w-3 mr-1" />
            Pending
          </span>
        );
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
    <div className="flex gap-6">
      <div className={`${selectedDomain ? 'w-1/2' : 'w-full'}`}>
        <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg">
          <div className="px-6 py-4 border-b border-hud-bg-elev flex items-center justify-between">
            <h3 className="text-lg font-medium text-white">Authenticated Domains</h3>
            <div className="flex items-center space-x-2">
              {isAdmin && (
                <>
                  <button
                    onClick={handleSync}
                    disabled={syncing}
                    className="inline-flex items-center px-3 py-1.5 border border-hud-cream-mute text-sm font-medium rounded-md text-hud-cream-soft bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50"
                  >
                    <RefreshCw className={`h-4 w-4 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
                    Sync
                  </button>
                  <button
                    onClick={() => { setAddError(null); setShowAddModal(true); }}
                    className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-white hover:text-hud-bg-deep bg-hud-gold-deep hover:bg-hud-gold"
                  >
                    <Plus className="h-4 w-4 mr-1.5" />
                    Add Domain
                  </button>
                </>
              )}
            </div>
          </div>

          {error && (
            <div className="px-6 py-3 bg-hud-plum/10 border-b border-hud-plum/20">
              <p className="text-sm text-hud-plum">{error}</p>
            </div>
          )}
          {notice && !error && (
            <div className="px-6 py-3 bg-hud-emerald/10 border-b border-hud-emerald/20">
              <p className="text-sm text-hud-emerald">{notice}</p>
            </div>
          )}

          {domains.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-hud-cream-dim">No domains configured</p>
              {isAdmin && (
                <button
                  onClick={() => { setAddError(null); setShowAddModal(true); }}
                  className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white hover:text-hud-bg-deep bg-hud-gold-deep hover:bg-hud-gold"
                >
                  Add Your First Domain
                </button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-hud-bg-elev">
              {domains.map((domain) => (
                <li
                  key={domain.id}
                  onClick={() => setSelectedDomain(domain)}
                  className={`px-6 py-4 hover:bg-hud-bg-elev/50 cursor-pointer flex items-center justify-between ${
                    selectedDomain?.id === domain.id ? 'bg-hud-bg-elev/50' : ''
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium text-white">{domain.domain}</p>
                    <p className="text-xs text-hud-cream-mute">
                      {domain.last_checked_at
                        ? `Last verified: ${new Date(domain.last_checked_at).toLocaleDateString()}`
                        : 'Never verified'}
                    </p>
                  </div>
                  <div className="flex items-center space-x-3">
                    {getStatusBadge(domain.status)}
                    <ChevronRight className="h-5 w-5 text-hud-cream-mute" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {selectedDomain && (
        <div className="w-1/2">
          <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg">
            <div className="px-6 py-4 border-b border-hud-bg-elev flex items-center justify-between">
              <div>
                <h3 className="text-lg font-medium text-white">{selectedDomain.domain}</h3>
                <div className="mt-1">{getStatusBadge(selectedDomain.status)}</div>
              </div>
              <button
                onClick={() => setSelectedDomain(null)}
                className="text-hud-cream-dim hover:text-hud-cream-soft"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-4">
              <h4 className="text-sm font-medium text-white mb-4">DNS Records</h4>
              {selectedDomain.dns_records.length === 0 ? (
                <p className="text-sm text-hud-cream-dim">No DNS records available</p>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-hud-cream-dim">
                    Add these records to your DNS provider to authenticate this domain:
                  </p>
                  <div className="overflow-x-auto">
                    <table className="min-w-full">
                      <thead>
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-hud-cream-mute uppercase">Type</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-hud-cream-mute uppercase">Host</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-hud-cream-mute uppercase">Value</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-hud-cream-mute uppercase">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hud-bg-elev">
                        {selectedDomain.dns_records.map((record, index) => (
                          <tr key={index}>
                            <td className="px-3 py-2 text-sm text-white">
                              {record.type}
                              {record.priority !== undefined && (
                                <span className="ml-1 text-xs text-hud-cream-mute">(priority {record.priority})</span>
                              )}
                              {record.record && (
                                <div className="text-xs text-hud-cream-mute">{record.record}</div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center">
                                <span className="text-xs font-mono text-hud-cream-soft truncate max-w-[150px]">
                                  {record.host}
                                </span>
                                <button
                                  onClick={() => copyToClipboard(record.host)}
                                  className="ml-2 text-hud-cream-mute hover:text-hud-cream-soft"
                                >
                                  <Copy className="h-3 w-3" />
                                </button>
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center">
                                <span className="text-xs font-mono text-hud-cream-soft truncate max-w-[150px]">
                                  {record.value}
                                </span>
                                <button
                                  onClick={() => copyToClipboard(record.value)}
                                  className="ml-2 text-hud-cream-mute hover:text-hud-cream-soft"
                                >
                                  <Copy className="h-3 w-3" />
                                </button>
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              {record.valid ? (
                                <CheckCircle className="h-4 w-4 text-hud-emerald" />
                              ) : (
                                <XCircle className="h-4 w-4 text-hud-plum" />
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {isAdmin && (
              <div className="px-6 py-4 bg-hud-bg-elev/30 rounded-b-lg flex justify-between">
                <button
                  onClick={() => handleVerify(selectedDomain.id)}
                  disabled={verifying === selectedDomain.id}
                  className="inline-flex items-center px-4 py-2 border border-hud-cream-mute text-sm font-medium rounded-md text-hud-cream-soft bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${verifying === selectedDomain.id ? 'animate-spin' : ''}`} />
                  Verify Now
                </button>
                <button
                  onClick={() => handleDelete(selectedDomain.id)}
                  disabled={deleting === selectedDomain.id}
                  className="inline-flex items-center px-4 py-2 border border-hud-plum/30 text-sm font-medium rounded-md text-hud-plum bg-hud-plum/10 hover:bg-hud-plum/20 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showAddModal && (
        <Portal><div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-dvh items-end justify-center px-4 pt-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-black/60 transition-opacity" onClick={() => setShowAddModal(false)} />
            <span className="hidden sm:inline-block sm:h-dvh sm:align-middle">&#8203;</span>
            <div className="inline-block transform overflow-hidden rounded-lg bg-hud-bg-card border border-hud-bg-elev px-4 pt-5 pb-4 text-left align-bottom shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6 sm:align-middle">
              <form onSubmit={handleAdd}>
                <div>
                  <h3 className="text-lg font-medium text-white">Add Domain</h3>
                  <p className="mt-1 text-sm text-hud-cream-dim">
                    The domain is registered in Resend; you'll get the DNS records (SPF, DKIM) to publish at your DNS provider.
                  </p>
                  {addError && (
                    <div className="mt-3 rounded-md bg-hud-plum/10 border border-hud-plum/20 px-3 py-2">
                      <p className="text-sm text-hud-plum">{addError}</p>
                    </div>
                  )}
                  <div className="mt-4">
                    <label htmlFor="domain" className="block text-sm font-medium text-hud-cream-soft">
                      Domain
                    </label>
                    <input
                      type="text"
                      id="domain"
                      value={newDomain}
                      onChange={(e) => setNewDomain(e.target.value)}
                      placeholder="example.com"
                      required
                      className="mt-1 block w-full bg-hud-bg-mid border-hud-cream-mute rounded-md text-white placeholder-hud-cream-dim focus:ring-hud-gold focus:border-hud-gold sm:text-sm"
                    />
                  </div>
                </div>
                <div className="mt-5 sm:mt-6 sm:flex sm:flex-row-reverse gap-3">
                  <button
                    type="submit"
                    disabled={adding || !newDomain}
                    className="inline-flex w-full justify-center rounded-md border border-transparent bg-hud-gold-deep px-4 py-2 text-sm font-medium text-white hover:text-hud-bg-deep hover:bg-hud-gold disabled:opacity-50 sm:w-auto"
                  >
                    {adding ? 'Adding...' : 'Add Domain'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="mt-3 inline-flex w-full justify-center rounded-md border border-hud-cream-mute bg-hud-bg-elev px-4 py-2 text-sm font-medium text-hud-cream-soft hover:bg-hud-cream-mute sm:mt-0 sm:w-auto"
                  >
                    Cancel
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
