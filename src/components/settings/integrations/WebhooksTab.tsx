import { useState, useEffect } from 'react';
import { Plus, Trash2, Power, Play, ExternalLink, CheckCircle, XCircle, Clock, ChevronDown, ChevronUp, Loader2, Edit2, ArrowUpRight } from 'lucide-react';
import { getWebhooks, deleteWebhook, toggleWebhook, testWebhook, getWebhookDeliveries } from '../../../services/webhooks';
import type { OutgoingWebhook, WebhookDelivery } from '../../../types';
import { WEBHOOK_EVENT_LABELS } from '../../../types';
import { WebhookFormDrawer } from './WebhookFormDrawer';

interface WebhooksTabProps {
  onSuccess?: () => void;
}

export function WebhooksTab({ onSuccess }: WebhooksTabProps) {
  const [webhooks, setWebhooks] = useState<OutgoingWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDrawer, setShowDrawer] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<OutgoingWebhook | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);

  useEffect(() => {
    loadWebhooks();
  }, []);

  useEffect(() => {
    if (expandedId) {
      loadDeliveries(expandedId);
    }
  }, [expandedId]);

  const loadWebhooks = async () => {
    try {
      setLoading(true);
      const data = await getWebhooks();
      setWebhooks(data);
    } catch (error) {
      console.error('Failed to load webhooks:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadDeliveries = async (webhookId: string) => {
    try {
      setLoadingDeliveries(true);
      const data = await getWebhookDeliveries({ webhookId });
      setDeliveries(data);
    } catch (error) {
      console.error('Failed to load deliveries:', error);
    } finally {
      setLoadingDeliveries(false);
    }
  };

  const handleTest = async (webhook: OutgoingWebhook) => {
    try {
      setTestingId(webhook.id);
      await testWebhook(webhook.id);
      if (expandedId === webhook.id) {
        loadDeliveries(webhook.id);
      }
    } catch (error) {
      console.error('Test failed:', error);
    } finally {
      setTestingId(null);
    }
  };

  const handleToggle = async (webhook: OutgoingWebhook) => {
    try {
      setTogglingId(webhook.id);
      await toggleWebhook(webhook.id, !webhook.enabled);
      loadWebhooks();
      onSuccess?.();
    } catch (error) {
      console.error('Toggle failed:', error);
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (webhook: OutgoingWebhook) => {
    if (!confirm(`Are you sure you want to delete the webhook "${webhook.name}"?`)) {
      return;
    }
    try {
      setDeletingId(webhook.id);
      await deleteWebhook(webhook.id);
      loadWebhooks();
      onSuccess?.();
    } catch (error) {
      console.error('Delete failed:', error);
    } finally {
      setDeletingId(null);
    }
  };

  const handleEdit = (webhook: OutgoingWebhook) => {
    setEditingWebhook(webhook);
    setShowDrawer(true);
  };

  const handleDrawerClose = () => {
    setShowDrawer(false);
    setEditingWebhook(null);
    loadWebhooks();
    onSuccess?.();
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'delivered':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-hud-emerald/10 px-2 py-0.5 text-xs font-medium text-hud-emerald">
            <CheckCircle className="h-3 w-3" />
            Delivered
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-hud-plum/10 px-2 py-0.5 text-xs font-medium text-hud-plum">
            <XCircle className="h-3 w-3" />
            Failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-hud-rust/10 px-2 py-0.5 text-xs font-medium text-hud-rust">
            <Clock className="h-3 w-3" />
            Pending
          </span>
        );
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
      <div className="flex items-center justify-between">
        <p className="text-sm text-hud-cream-dim">
          Configure outgoing webhooks to send event data to external systems in real-time.
        </p>
        <button
          onClick={() => setShowDrawer(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal px-4 py-2 text-sm font-medium text-white shadow-lg shadow-hud-gold/25 transition-all hover:shadow-hud-gold/40"
        >
          <Plus className="h-4 w-4" />
          Create Webhook
        </button>
      </div>

      {webhooks.length === 0 ? (
        <div className="rounded-lg border border-hud-bg-elev bg-hud-bg-card p-12 text-center">
          <ExternalLink className="mx-auto h-12 w-12 text-hud-cream-mute" />
          <h3 className="mt-4 text-lg font-medium text-white">No Webhooks Configured</h3>
          <p className="mt-2 text-sm text-hud-cream-dim">
            Create a webhook to start sending event notifications to external systems.
          </p>
          <button
            onClick={() => setShowDrawer(true)}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal px-4 py-2 text-sm font-medium text-white shadow-lg shadow-hud-gold/25 transition-all hover:shadow-hud-gold/40"
          >
            <Plus className="h-4 w-4" />
            Create Webhook
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {webhooks.map((webhook) => (
            <div
              key={webhook.id}
              className="overflow-hidden rounded-lg border border-hud-bg-elev bg-hud-bg-card"
            >
              <div className="flex items-center justify-between px-6 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <h4 className="font-medium text-white">{webhook.name}</h4>
                    {webhook.enabled ? (
                      <span className="rounded-full bg-hud-emerald/10 px-2 py-0.5 text-xs font-medium text-hud-emerald">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full bg-hud-bg-elev px-2 py-0.5 text-xs font-medium text-hud-cream-dim">
                        Disabled
                      </span>
                    )}
                    <span className="rounded bg-hud-gold/10 px-2 py-0.5 text-xs font-medium text-hud-gold-soft">
                      <ArrowUpRight className="mr-1 inline h-3 w-3" />
                      Outbound
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-hud-cream-mute truncate max-w-lg">{webhook.url}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {webhook.events.slice(0, 3).map((event) => (
                      <span
                        key={event}
                        className="rounded bg-hud-bg-elev px-2 py-0.5 text-xs text-hud-cream-dim"
                      >
                        {WEBHOOK_EVENT_LABELS[event] || event}
                      </span>
                    ))}
                    {webhook.events.length > 3 && (
                      <span className="rounded bg-hud-bg-elev px-2 py-0.5 text-xs text-hud-cream-dim">
                        +{webhook.events.length - 3} more
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTest(webhook)}
                    disabled={testingId === webhook.id || !webhook.enabled}
                    className="rounded p-2 text-hud-cream-dim transition-colors hover:bg-hud-bg-elev hover:text-white disabled:opacity-50"
                    title="Test Webhook"
                  >
                    <Play className={`h-4 w-4 ${testingId === webhook.id ? 'animate-pulse' : ''}`} />
                  </button>
                  <button
                    onClick={() => handleEdit(webhook)}
                    className="rounded p-2 text-hud-cream-dim transition-colors hover:bg-hud-bg-elev hover:text-white"
                    title="Edit Webhook"
                  >
                    <Edit2 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleToggle(webhook)}
                    disabled={togglingId === webhook.id}
                    className={`rounded p-2 transition-colors hover:bg-hud-bg-elev disabled:opacity-50 ${
                      webhook.enabled ? 'text-hud-emerald' : 'text-hud-cream-mute'
                    }`}
                    title={webhook.enabled ? 'Disable' : 'Enable'}
                  >
                    <Power className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(webhook)}
                    disabled={deletingId === webhook.id}
                    className="rounded p-2 text-hud-cream-dim transition-colors hover:bg-hud-plum/10 hover:text-hud-plum disabled:opacity-50"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setExpandedId(expandedId === webhook.id ? null : webhook.id)}
                    className="rounded p-2 text-hud-cream-dim transition-colors hover:bg-hud-bg-elev hover:text-white"
                    title="View Deliveries"
                  >
                    {expandedId === webhook.id ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              {expandedId === webhook.id && (
                <div className="border-t border-hud-bg-elev bg-hud-bg-mid px-6 py-4">
                  <h5 className="text-sm font-medium text-hud-cream-soft">Recent Deliveries</h5>
                  {loadingDeliveries ? (
                    <div className="py-4 text-center">
                      <Loader2 className="inline-block h-5 w-5 animate-spin text-hud-gold" />
                    </div>
                  ) : deliveries.length === 0 ? (
                    <p className="mt-2 text-sm text-hud-cream-mute">No deliveries yet</p>
                  ) : (
                    <div className="mt-3 overflow-x-auto">
                      <table className="min-w-full divide-y divide-hud-bg-elev/50">
                        <thead>
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-mute">
                              Event
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-mute">
                              Status
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-mute">
                              Response
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-mute">
                              Attempts
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-mute">
                              Timestamp
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-hud-bg-elev/30">
                          {deliveries.slice(0, 10).map((delivery) => (
                            <tr key={delivery.id} className="hover:bg-hud-bg-card/50">
                              <td className="whitespace-nowrap px-3 py-2 text-sm text-white">
                                {WEBHOOK_EVENT_LABELS[delivery.event_type] || delivery.event_type}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2">
                                {getStatusBadge(delivery.status)}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-sm text-hud-cream-dim">
                                {delivery.response_code || '-'}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-sm text-hud-cream-dim">
                                {delivery.attempts}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-sm text-hud-cream-mute">
                                {formatDate(delivery.created_at)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showDrawer && (
        <WebhookFormDrawer
          webhook={editingWebhook}
          onClose={handleDrawerClose}
        />
      )}
    </div>
  );
}
