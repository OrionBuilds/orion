import { useState, useEffect } from 'react';
import { Calendar, Filter, CheckCircle, XCircle, RefreshCw, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { getIntegrationLogs } from '../../../services/integrations';
import type { IntegrationLog, IntegrationLogAction } from '../../../types';
import { formatDateTimeShort } from '../../../utils/formatters';

const actionOptions: { value: IntegrationLogAction | ''; label: string }[] = [
  { value: '', label: 'All Actions' },
  { value: 'connect', label: 'Connect' },
  { value: 'disconnect', label: 'Disconnect' },
  { value: 'enable', label: 'Enable' },
  { value: 'disable', label: 'Disable' },
  { value: 'test', label: 'Test' },
  { value: 'sync', label: 'Sync' },
  { value: 'error', label: 'Error' },
  { value: 'token_refresh', label: 'Token Refresh' },
];

const statusOptions = [
  { value: '', label: 'All Status' },
  { value: 'success', label: 'Success' },
  { value: 'failure', label: 'Failure' },
];

export function IntegrationLogsTab() {
  const [logs, setLogs] = useState<IntegrationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState<IntegrationLogAction | ''>('');
  const [statusFilter, setStatusFilter] = useState<'success' | 'failure' | ''>('');
  const [dateFilter, setDateFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    loadLogs();
  }, [actionFilter, statusFilter, dateFilter]);

  const loadLogs = async () => {
    try {
      setLoading(true);
      const data = await getIntegrationLogs({
        action: actionFilter ? [actionFilter] : undefined,
        status: statusFilter ? [statusFilter] : undefined,
        startDate: dateFilter || undefined,
      });
      setLogs(data);
    } catch (error) {
      console.error('Failed to load logs:', error);
    } finally {
      setLoading(false);
    }
  };

  const getActionBadgeColor = (action: string) => {
    switch (action) {
      case 'connect':
        return 'bg-hud-emerald/10 text-hud-emerald';
      case 'disconnect':
        return 'bg-hud-plum/10 text-hud-plum';
      case 'enable':
        return 'bg-hud-gold/10 text-hud-gold-soft';
      case 'disable':
        return 'bg-hud-bg-elev text-hud-cream-dim';
      case 'test':
        return 'bg-purple-500/10 text-purple-400';
      case 'sync':
        return 'bg-hud-gold/10 text-hud-gold-soft';
      case 'error':
        return 'bg-hud-plum/10 text-hud-plum';
      case 'token_refresh':
        return 'bg-hud-rust/10 text-hud-rust';
      default:
        return 'bg-hud-bg-elev text-hud-cream-dim';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-hud-cream-mute" />
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value as IntegrationLogAction | '')}
            className="rounded-lg border border-hud-bg-elev bg-hud-bg-card py-2 pl-3 pr-8 text-sm text-white focus:border-hud-gold focus:outline-none focus:ring-1 focus:ring-hud-gold"
          >
            {actionOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'success' | 'failure' | '')}
          className="rounded-lg border border-hud-bg-elev bg-hud-bg-card py-2 pl-3 pr-8 text-sm text-white focus:border-hud-gold focus:outline-none focus:ring-1 focus:ring-hud-gold"
        >
          {statusOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-hud-cream-mute" />
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="rounded-lg border border-hud-bg-elev bg-hud-bg-card py-2 px-3 text-sm text-white focus:border-hud-gold focus:outline-none focus:ring-1 focus:ring-hud-gold"
          />
        </div>
        <button
          onClick={loadLogs}
          className="inline-flex items-center gap-2 rounded-lg border border-hud-bg-elev bg-hud-bg-card px-3 py-2 text-sm font-medium text-white hover:bg-hud-bg-elev"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {logs.length === 0 ? (
        <div className="rounded-lg border border-hud-bg-elev bg-hud-bg-card p-12 text-center">
          <p className="text-hud-cream-dim">No activity logs found</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-hud-bg-elev bg-hud-bg-card">
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-hud-bg-elev">
            <thead className="bg-hud-bg-card/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                  Timestamp
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                  Integration
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                  Action
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                  User
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hud-bg-elev/50 bg-hud-bg-mid">
              {logs.map((log) => (
                <>
                  <tr key={log.id} className="transition-colors hover:bg-hud-bg-card/50">
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-hud-cream-dim">
                      {formatDateTimeShort(log.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4">
                      <span className="text-sm font-medium text-white">
                        {(log.integration as any)?.name || 'Unknown'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4">
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium capitalize ${getActionBadgeColor(
                          log.action
                        )}`}
                      >
                        {log.action.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4">
                      {log.status === 'success' ? (
                        <span className="inline-flex items-center gap-1 text-sm text-hud-emerald">
                          <CheckCircle className="h-4 w-4" />
                          Success
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-sm text-hud-plum">
                          <XCircle className="h-4 w-4" />
                          Failed
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-hud-cream-dim">
                      {(log.user as any)?.name || (log.user as any)?.email || 'System'}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right">
                      <button
                        onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                        className="rounded p-1.5 text-hud-cream-dim transition-colors hover:bg-hud-bg-elev hover:text-white"
                      >
                        {expandedId === log.id ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                  </tr>
                  {expandedId === log.id && (
                    <tr key={`${log.id}-details`} className="bg-hud-bg-deep">
                      <td colSpan={6} className="px-6 py-4">
                        <div className="space-y-4">
                          {log.error_message && (
                            <div>
                              <h4 className="text-xs font-medium uppercase tracking-wider text-hud-cream-mute mb-2">
                                Error Message
                              </h4>
                              <div className="rounded-lg border border-hud-plum/30 bg-hud-plum/10 p-3 text-sm text-hud-plum">
                                {log.error_message}
                              </div>
                            </div>
                          )}

                          {log.request_meta && (
                            <div>
                              <h4 className="text-xs font-medium uppercase tracking-wider text-hud-cream-mute mb-2">
                                Request Metadata
                              </h4>
                              <pre className="overflow-x-auto rounded-lg border border-hud-bg-elev bg-hud-bg-mid p-3 text-xs text-hud-gold-soft">
                                {JSON.stringify(log.request_meta, null, 2)}
                              </pre>
                            </div>
                          )}

                          {!log.error_message && !log.request_meta && (
                            <p className="text-sm text-hud-cream-mute">No additional details available</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
