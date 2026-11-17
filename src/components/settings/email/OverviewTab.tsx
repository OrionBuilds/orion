import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, XCircle, AlertTriangle, Mail, Globe, AtSign, Send, ArrowRight } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getEmailSetupStatus, getTestEmailLogs } from '../../../services/emailSend';
import { getProviderStatus, RESEND_INTEGRATION_PATH } from '../../../services/emailProviders';
import type { EmailSetupStatus, EmailTestLog } from '../../../types';

interface OverviewTabProps {
  onNavigate: (tab: 'domains' | 'from-addresses' | 'test') => void;
}

export function OverviewTab({ onNavigate }: OverviewTabProps) {
  const { user, hasPermission } = useAuth();
  const [status, setStatus] = useState<EmailSetupStatus | null>(null);
  const [resendConfigured, setResendConfigured] = useState<boolean | null>(null);
  const [lastTestLog, setLastTestLog] = useState<EmailTestLog | null>(null);
  const [loading, setLoading] = useState(true);

  const isAdmin = hasPermission('email.settings.manage');
  const canTest = hasPermission('email.send.test');

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.organization_id]);

  const loadData = async () => {
    if (!user?.organization_id) return;
    try {
      const [statusData, providerStatus, testLogs] = await Promise.all([
        getEmailSetupStatus(),
        getProviderStatus(user.organization_id).catch(() => null),
        getTestEmailLogs(user.organization_id, 1),
      ]);
      setStatus(statusData);
      setResendConfigured(providerStatus ? providerStatus.envConfigured : statusData.providerConnected);
      setLastTestLog(testLogs[0] || null);
    } catch (error) {
      console.error('Failed to load email status:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  if (!status) {
    return (
      <div className="text-center py-12 text-hud-cream-dim">
        Unable to load email configuration status
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!status.isConfigured && (
        <div className="rounded-lg bg-hud-plum/10 border border-hud-plum/20 p-4">
          <div className="flex">
            <AlertTriangle className="h-5 w-5 text-hud-plum mr-3 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-hud-plum">Email Sending Blocked</h3>
              <div className="mt-2 text-sm text-hud-plum/80">
                <p>The following issues are preventing email sending:</p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  {status.blockingReasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-sm text-hud-cream-dim">
        {resendConfigured ? (
          <CheckCircle className="h-4 w-4 text-hud-emerald flex-shrink-0" />
        ) : (
          <XCircle className="h-4 w-4 text-hud-plum flex-shrink-0" />
        )}
        <span>
          Resend API key {resendConfigured ? 'configured' : 'not configured'} ·{' '}
          <Link to={RESEND_INTEGRATION_PATH} className="text-hud-gold-soft hover:underline">
            Manage in Integrations → Resend
          </Link>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg overflow-hidden">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <Globe className={`h-8 w-8 ${status.verifiedDomainsCount > 0 ? 'text-hud-emerald' : 'text-hud-cream-mute'}`} />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-hud-cream-dim truncate">Verified Domains</dt>
                  <dd className="text-lg font-semibold text-white">
                    {status.verifiedDomainsCount}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
          {isAdmin && status.verifiedDomainsCount === 0 && (
            <div className="bg-hud-bg-elev/50 px-5 py-3">
              <button
                onClick={() => onNavigate('domains')}
                className="text-sm font-medium text-hud-gold-soft hover:text-hud-gold-soft flex items-center"
              >
                Add Domain <ArrowRight className="ml-1 h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg overflow-hidden">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <AtSign className={`h-8 w-8 ${status.activeFromAddressesCount > 0 ? 'text-hud-emerald' : 'text-hud-cream-mute'}`} />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-hud-cream-dim truncate">From Addresses</dt>
                  <dd className="text-lg font-semibold text-white">
                    {status.activeFromAddressesCount}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
          {isAdmin && status.activeFromAddressesCount === 0 && (
            <div className="bg-hud-bg-elev/50 px-5 py-3">
              <button
                onClick={() => onNavigate('from-addresses')}
                className="text-sm font-medium text-hud-gold-soft hover:text-hud-gold-soft flex items-center"
              >
                Add Address <ArrowRight className="ml-1 h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg overflow-hidden">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <Send className={`h-8 w-8 ${status.isConfigured ? 'text-hud-emerald' : 'text-hud-cream-mute'}`} />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-hud-cream-dim truncate">Ready to Send</dt>
                  <dd className="text-lg font-semibold text-white">
                    {status.isConfigured ? 'Yes' : 'No'}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
          {canTest && status.isConfigured && (
            <div className="bg-hud-bg-elev/50 px-5 py-3">
              <button
                onClick={() => onNavigate('test')}
                className="text-sm font-medium text-hud-gold-soft hover:text-hud-gold-soft flex items-center"
              >
                Send Test <ArrowRight className="ml-1 h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {lastTestLog && (
        <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-6">
          <h3 className="text-lg font-medium text-white mb-4">Last Test Email</h3>
          <div className="flex items-center space-x-4">
            {lastTestLog.status === 'success' ? (
              <CheckCircle className="h-5 w-5 text-hud-emerald" />
            ) : (
              <XCircle className="h-5 w-5 text-hud-plum" />
            )}
            <div>
              <p className="text-sm text-white">
                Sent to <span className="font-medium">{lastTestLog.to_email}</span>
              </p>
              <p className="text-sm text-hud-cream-dim">
                {new Date(lastTestLog.sent_at).toLocaleString()}
                {lastTestLog.status === 'failed' && lastTestLog.error_message && (
                  <span className="text-hud-plum ml-2">- {lastTestLog.error_message}</span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-6">
        <h3 className="text-lg font-medium text-white mb-4">Email Integration Usage</h3>
        <p className="text-sm text-hud-cream-dim mb-4">
          Once configured, Resend delivers email for the following features:
        </p>
        <ul className="space-y-3">
          <li className="flex items-center text-sm text-hud-cream-soft">
            <Mail className="h-5 w-5 mr-3 text-hud-cream-mute" />
            <span><strong className="text-white">Conversations</strong> - Send emails to contacts with the org sender</span>
          </li>
          <li className="flex items-center text-sm text-hud-cream-soft">
            <Mail className="h-5 w-5 mr-3 text-hud-cream-mute" />
            <span><strong className="text-white">Bookings, proposals & portal</strong> - Confirmations, signature requests, sign-in codes</span>
          </li>
          <li className="flex items-center text-sm text-hud-cream-soft">
            <Mail className="h-5 w-5 mr-3 text-hud-cream-mute" />
            <span><strong className="text-white">Reports & meeting follow-ups</strong> - Scheduled reports and follow-up emails</span>
          </li>
          <li className="flex items-center text-sm text-hud-cream-soft">
            <Mail className="h-5 w-5 mr-3 text-hud-cream-mute" />
            <span><strong className="text-white">Notifications</strong> - Operational alerts to your team</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
