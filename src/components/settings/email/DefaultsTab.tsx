import { useState, useEffect } from 'react';
import { Save, CheckCircle, Mail, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getEmailDefaults, updateEmailDefaults } from '../../../services/emailDefaults';
import { getFromAddresses, markDefaultFromAddress } from '../../../services/emailFromAddresses';
import { getUnsubscribeGroups, markDefaultUnsubscribeGroup } from '../../../services/emailUnsubscribeGroups';
import { getDomainTracking, setDomainTracking } from '../../../services/emailDomains';
import type { EmailFromAddress, EmailUnsubscribeGroup, EmailDefaults } from '../../../types';

const USAGE: Array<{ label: string; detail: string; transactional?: boolean }> = [
  { label: 'Conversations', detail: 'emails sent with the org Resend sender (including AI agent drafts you send)' },
  { label: 'Reports', detail: 'scheduled report delivery emails' },
  { label: 'Meeting follow-ups', detail: 'when the meeting owner has no connected mailbox' },
  { label: 'AI Readiness Scorecard', detail: 'results email' },
  { label: 'Test Email', detail: 'the Test Email tab' },
  { label: 'Bookings', detail: 'confirmation, reschedule, cancel and reminder emails', transactional: true },
  { label: 'Proposals & contracts', detail: 'signature requests and reminders', transactional: true },
  { label: 'Client portal & deliverables', detail: 'sign-in codes, invites and delivered reports', transactional: true },
  { label: 'Support tickets, change requests & invoices', detail: 'receipts and payment reminders', transactional: true },
  { label: 'Notifications', detail: 'operational alerts (e.g. form submissions) to your team', transactional: true },
];

export function DefaultsTab() {
  const { user, hasPermission } = useAuth();
  const [, setDefaults] = useState<EmailDefaults | null>(null);
  const [fromAddresses, setFromAddresses] = useState<EmailFromAddress[]>([]);
  const [unsubscribeGroups, setUnsubscribeGroups] = useState<EmailUnsubscribeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [savedTracking, setSavedTracking] = useState<{ track_opens: boolean; track_clicks: boolean } | null>(null);
  const [trackingSource, setTrackingSource] = useState<'resend' | 'defaults'>('defaults');

  const [formData, setFormData] = useState({
    default_from_address_id: '',
    default_reply_to: '',
    default_unsubscribe_group_id: '',
    track_opens: true,
    track_clicks: true,
  });

  const isAdmin = hasPermission('email.settings.manage');
  const activeFromAddresses = fromAddresses.filter(a => a.active);

  useEffect(() => {
    loadData();
  }, [user?.organization_id]);

  const loadData = async () => {
    if (!user?.organization_id) return;
    try {
      const [defaultsData, addressData, groupData, tracking] = await Promise.all([
        getEmailDefaults(user.organization_id),
        getFromAddresses(user.organization_id),
        getUnsubscribeGroups(user.organization_id),
        // Resend tracks opens/clicks per domain — read the live domain setting when available.
        getDomainTracking().catch(() => null),
      ]);
      setDefaults(defaultsData);
      setFromAddresses(addressData);
      setUnsubscribeGroups(groupData);
      setTrackingSource(tracking?.source ?? 'defaults');

      const fallbackFrom = addressData.find(a => a.is_default && a.active)?.id || '';
      const fallbackGroup = groupData.find(g => g.is_default)?.id || '';
      const next = {
        default_from_address_id: defaultsData?.default_from_address_id || fallbackFrom,
        default_reply_to: defaultsData?.default_reply_to || '',
        default_unsubscribe_group_id: defaultsData?.default_unsubscribe_group_id || fallbackGroup,
        track_opens: tracking?.trackOpens ?? defaultsData?.track_opens ?? true,
        track_clicks: tracking?.trackClicks ?? defaultsData?.track_clicks ?? true,
      };
      setFormData(next);
      setSavedTracking({ track_opens: next.track_opens, track_clicks: next.track_clicks });
    } catch (err) {
      console.error('Failed to load data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load email defaults');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.organization_id) return;
    const orgId = user.organization_id;

    setSaving(true);
    setError(null);
    setWarning(null);
    setSuccess(false);

    try {
      const replyTo = formData.default_reply_to.trim();
      if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
        setError('Default Reply-To must be a valid email address');
        return;
      }
      const fromId = formData.default_from_address_id || null;
      const groupId = formData.default_unsubscribe_group_id || null;

      const result = await updateEmailDefaults(orgId, {
        default_from_address_id: fromId,
        default_reply_to: replyTo || null,
        default_unsubscribe_group_id: groupId,
      });
      if (!result.success) {
        setError(result.error || 'Failed to save defaults');
        return;
      }

      // Keep the From Addresses / Unsubscribe Groups tabs' "default" markers in step.
      const [fromSync, groupSync] = await Promise.all([
        markDefaultFromAddress(orgId, fromId, false),
        markDefaultUnsubscribeGroup(orgId, groupId, false),
      ]);
      if (!fromSync.success || !groupSync.success) {
        setError(fromSync.error || groupSync.error || 'Failed to update default markers');
        return;
      }

      // Tracking lives on the Resend domain: PATCH it (the edge function also persists the flags).
      const trackingChanged =
        !savedTracking ||
        savedTracking.track_opens !== formData.track_opens ||
        savedTracking.track_clicks !== formData.track_clicks;
      if (trackingChanged) {
        const t = await setDomainTracking(formData.track_opens, formData.track_clicks);
        if (!t.success) {
          setError(`Sender settings saved, but tracking was not updated: ${t.error}`);
          return;
        }
        if (t.warning) setWarning(t.warning);
        setSavedTracking({ track_opens: formData.track_opens, track_clicks: formData.track_clicks });
        setTrackingSource('resend');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred while saving');
    } finally {
      setSaving(false);
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
    <div className="max-w-2xl">
      <form onSubmit={handleSubmit}>
        <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg">
          <div className="px-6 py-4 border-b border-hud-bg-elev">
            <h3 className="text-lg font-medium text-white">Email Defaults</h3>
            <p className="mt-1 text-sm text-hud-cream-dim">
              Configure default settings for all outgoing emails
            </p>
          </div>

          {error && (
            <div className="px-6 py-3 bg-hud-plum/10 border-b border-hud-plum/20">
              <p className="text-sm text-hud-plum">{error}</p>
            </div>
          )}

          {success && (
            <div className="px-6 py-3 bg-hud-emerald/10 border-b border-hud-emerald/20 flex items-center">
              <CheckCircle className="h-5 w-5 text-hud-emerald mr-2" />
              <p className="text-sm text-hud-emerald">Settings saved successfully</p>
            </div>
          )}

          {warning && (
            <div className="px-6 py-3 bg-hud-rust/10 border-b border-hud-rust/20 flex items-center">
              <AlertTriangle className="h-5 w-5 text-hud-rust mr-2" />
              <p className="text-sm text-hud-rust">{warning}</p>
            </div>
          )}

          <div className="px-6 py-6 space-y-6">
            <div>
              <h4 className="text-sm font-medium text-white mb-4">Sender Settings</h4>
              <div className="space-y-4">
                <div>
                  <label htmlFor="default_from_address_id" className="block text-sm font-medium text-hud-cream-soft">
                    Default From Address
                  </label>
                  <select
                    id="default_from_address_id"
                    value={formData.default_from_address_id}
                    onChange={(e) => setFormData({ ...formData, default_from_address_id: e.target.value })}
                    disabled={!isAdmin}
                    className="mt-1 block w-full bg-hud-bg-mid border-hud-cream-mute rounded-md text-white focus:ring-hud-gold focus:border-hud-gold sm:text-sm disabled:opacity-50"
                  >
                    <option value="">Select a from address...</option>
                    {activeFromAddresses.map((address) => (
                      <option key={address.id} value={address.id}>
                        {address.display_name} &lt;{address.email}&gt;
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-hud-cream-mute">
                    Used when an email is sent without a specific from address
                  </p>
                </div>

                <div>
                  <label htmlFor="default_reply_to" className="block text-sm font-medium text-hud-cream-soft">
                    Default Reply-To Address
                  </label>
                  <input
                    type="email"
                    id="default_reply_to"
                    value={formData.default_reply_to}
                    onChange={(e) => setFormData({ ...formData, default_reply_to: e.target.value })}
                    disabled={!isAdmin}
                    placeholder="replies@example.com"
                    className="mt-1 block w-full bg-hud-bg-mid border-hud-cream-mute rounded-md text-white placeholder-hud-cream-dim focus:ring-hud-gold focus:border-hud-gold sm:text-sm disabled:opacity-50"
                  />
                  <p className="mt-1 text-xs text-hud-cream-mute">
                    Used when no reply-to is specified on the from address
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t border-hud-bg-elev pt-6">
              <h4 className="text-sm font-medium text-white mb-1">Tracking Settings</h4>
              <p className="text-xs text-hud-cream-mute mb-4">
                Resend applies tracking per sending domain: saving updates every domain in the Domains tab.
                {trackingSource === 'resend' ? ' Showing the current Resend setting.' : ''}
              </p>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <label htmlFor="track_opens" className="text-sm font-medium text-hud-cream-soft">
                      Track email opens
                    </label>
                    <p className="text-xs text-hud-cream-mute">
                      Adds a tracking pixel to detect when recipients open emails
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => isAdmin && setFormData({ ...formData, track_opens: !formData.track_opens })}
                    disabled={!isAdmin}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                      formData.track_opens ? 'bg-hud-gold-deep' : 'bg-hud-cream-mute'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        formData.track_opens ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <label htmlFor="track_clicks" className="text-sm font-medium text-hud-cream-soft">
                      Track link clicks
                    </label>
                    <p className="text-xs text-hud-cream-mute">
                      Rewrites links through Resend to track clicks. Can break signed links (signature, portal) in some mail clients.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => isAdmin && setFormData({ ...formData, track_clicks: !formData.track_clicks })}
                    disabled={!isAdmin}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                      formData.track_clicks ? 'bg-hud-gold-deep' : 'bg-hud-cream-mute'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        formData.track_clicks ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            <div className="border-t border-hud-bg-elev pt-6">
              <h4 className="text-sm font-medium text-white mb-4">Unsubscribe Settings</h4>
              <div>
                <label htmlFor="default_unsubscribe_group_id" className="block text-sm font-medium text-hud-cream-soft">
                  Default Unsubscribe Group
                </label>
                <select
                  id="default_unsubscribe_group_id"
                  value={formData.default_unsubscribe_group_id}
                  onChange={(e) => setFormData({ ...formData, default_unsubscribe_group_id: e.target.value })}
                  disabled={!isAdmin}
                  className="mt-1 block w-full bg-hud-bg-mid border-hud-cream-mute rounded-md text-white focus:ring-hud-gold focus:border-hud-gold sm:text-sm disabled:opacity-50"
                >
                  <option value="">Select an unsubscribe group...</option>
                  {unsubscribeGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-hud-cream-mute">
                  Non-transactional emails get a one-click List-Unsubscribe header and an unsubscribe footer link;
                  unsubscribed recipients are skipped. Leave empty to send without an unsubscribe link.
                </p>
              </div>
            </div>

            <div className="border-t border-hud-bg-elev pt-6">
              <h4 className="text-sm font-medium text-white mb-4">Usage Information</h4>
              <p className="text-sm text-hud-cream-dim mb-3">
                These defaults apply to every email the platform sends through Resend:
              </p>
              <ul className="text-sm text-hud-cream-dim space-y-2">
                {USAGE.map((item) => (
                  <li key={item.label} className="flex items-start">
                    <Mail className="h-4 w-4 mr-2 mt-0.5 text-hud-cream-mute flex-shrink-0" />
                    <span>
                      <span className="text-hud-cream-soft">{item.label}</span> - {item.detail}
                      {item.transactional && (
                        <span className="ml-1 text-xs text-hud-cream-mute">(transactional: no unsubscribe link)</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-hud-cream-mute">
                Emails sent from a user's connected Gmail or Outlook mailbox use that mailbox, not these defaults.
              </p>
            </div>
          </div>

          {isAdmin && (
            <div className="px-6 py-4 bg-hud-bg-elev/30 rounded-b-lg">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white hover:text-hud-bg-deep bg-hud-gold-deep hover:bg-hud-gold disabled:opacity-50"
              >
                <Save className="h-4 w-4 mr-2" />
                {saving ? 'Saving...' : 'Save Defaults'}
              </button>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
