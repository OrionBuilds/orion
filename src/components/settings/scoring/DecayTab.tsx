import { useState, useEffect } from 'react';
import { Timer, Bell, Mail, MessageSquare } from 'lucide-react';
import { getModels, getDecayConfig, updateDecayConfig, type ScoringModel, type DecayConfig } from '../../../services/scoring';

export function DecayTab() {
  const [models, setModels] = useState<ScoringModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [config, setConfig] = useState<DecayConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [decayType, setDecayType] = useState<'linear' | 'step'>('linear');
  const [decayAmount, setDecayAmount] = useState(5);
  const [intervalDays, setIntervalDays] = useState(30);
  const [minScoreFloor, setMinScoreFloor] = useState(0);
  const [notificationThreshold, setNotificationThreshold] = useState<number | ''>('');
  const [notifyInApp, setNotifyInApp] = useState(true);
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [notifySms, setNotifySms] = useState(false);

  useEffect(() => {
    loadModels();
  }, []);

  useEffect(() => {
    if (selectedModelId) {
      loadConfig(selectedModelId);
    }
  }, [selectedModelId]);

  async function loadModels() {
    try {
      const data = await getModels();
      setModels(data);
      if (data.length > 0) {
        const primary = data.find(m => m.is_primary) || data[0];
        setSelectedModelId(primary.id);
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setLoading(false);
    }
  }

  async function loadConfig(modelId: string) {
    try {
      setLoading(true);
      const data = await getDecayConfig(modelId);
      setConfig(data);
      if (data) {
        setEnabled(data.enabled);
        setDecayType(data.decay_type);
        setDecayAmount(data.decay_amount);
        setIntervalDays(data.interval_days);
        setMinScoreFloor(data.min_score_floor);
        setNotificationThreshold(data.notification_threshold ?? '');
        setNotifyInApp(data.notify_in_app);
        setNotifyEmail(data.notify_email);
        setNotifySms(data.notify_sms);
      }
    } catch (error) {
      console.error('Failed to load decay config:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!selectedModelId) return;

    try {
      setSaving(true);
      await updateDecayConfig(selectedModelId, {
        enabled,
        decayType,
        decayAmount,
        intervalDays,
        minScoreFloor,
        notificationThreshold: notificationThreshold === '' ? null : Number(notificationThreshold),
        notifyInApp,
        notifyEmail,
        notifySms,
      });
      await loadConfig(selectedModelId);
    } catch (error) {
      console.error('Failed to save decay config:', error);
    } finally {
      setSaving(false);
    }
  }

  function calculateDecayPreview(): string {
    if (!enabled) return 'Decay is disabled';
    const startScore = 100;
    let score = startScore;
    const days = intervalDays * 3;
    const intervals = Math.floor(days / intervalDays);

    for (let i = 0; i < intervals; i++) {
      score = Math.max(minScoreFloor, score - decayAmount);
    }

    return `A score of ${startScore} will decay to ${score} after ${days} days (${intervals} decay cycles)`;
  }

  if (loading && models.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <label className="text-sm font-medium text-hud-cream-dim">Model:</label>
        <select
          value={selectedModelId}
          onChange={(e) => setSelectedModelId(e.target.value)}
          className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
        >
          <option value="">Select a model</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} ({model.scope})
            </option>
          ))}
        </select>
      </div>

      {!selectedModelId ? (
        <div className="text-center py-12 bg-hud-bg-card/50 rounded-lg border border-dashed border-hud-bg-elev">
          <p className="text-hud-cream-dim">Select a scoring model to configure decay settings.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-hud-bg-card rounded-lg border border-hud-bg-elev p-6 space-y-6">
            <div className="flex items-center gap-3">
              <Timer className="h-5 w-5 text-hud-gold-soft" />
              <h3 className="text-lg font-medium text-white">Decay Settings</h3>
            </div>

            <label className="flex items-center justify-between">
              <span className="text-sm font-medium text-hud-cream-soft">Enable score decay</span>
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  enabled ? 'bg-hud-gold' : 'bg-hud-cream-mute'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </label>

            {enabled && (
              <>
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">Decay Type</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="decayType"
                        value="linear"
                        checked={decayType === 'linear'}
                        onChange={() => setDecayType('linear')}
                        className="text-hud-gold bg-hud-bg-mid border-hud-cream-mute focus:ring-hud-gold"
                      />
                      <span className="text-sm text-hud-cream-soft">Linear</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="decayType"
                        value="step"
                        checked={decayType === 'step'}
                        onChange={() => setDecayType('step')}
                        className="text-hud-gold bg-hud-bg-mid border-hud-cream-mute focus:ring-hud-gold"
                      />
                      <span className="text-sm text-hud-cream-soft">Step</span>
                    </label>
                  </div>
                  <p className="mt-1 text-xs text-hud-cream-mute">
                    {decayType === 'linear'
                      ? 'Subtract points at regular intervals'
                      : 'Apply decay at specific milestones'}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-hud-cream-soft mb-1">
                      Decay Amount
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={decayAmount}
                        onChange={(e) => setDecayAmount(Number(e.target.value))}
                        min={1}
                        className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
                      />
                      <span className="text-sm text-hud-cream-dim">points</span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-hud-cream-soft mb-1">
                      Interval
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={intervalDays}
                        onChange={(e) => setIntervalDays(Number(e.target.value))}
                        min={1}
                        className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
                      />
                      <span className="text-sm text-hud-cream-dim">days</span>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1">
                    Minimum Score Floor
                  </label>
                  <input
                    type="number"
                    value={minScoreFloor}
                    onChange={(e) => setMinScoreFloor(Number(e.target.value))}
                    min={0}
                    className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
                  />
                  <p className="mt-1 text-xs text-hud-cream-mute">Score will not decay below this value</p>
                </div>

                <div className="p-4 bg-hud-bg-mid rounded-lg border border-hud-bg-elev">
                  <p className="text-sm text-hud-cream-soft">{calculateDecayPreview()}</p>
                </div>
              </>
            )}
          </div>

          <div className="bg-hud-bg-card rounded-lg border border-hud-bg-elev p-6 space-y-6">
            <div className="flex items-center gap-3">
              <Bell className="h-5 w-5 text-hud-gold-soft" />
              <h3 className="text-lg font-medium text-white">Notification Settings</h3>
            </div>

            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">
                Alert Threshold
              </label>
              <input
                type="number"
                value={notificationThreshold}
                onChange={(e) => setNotificationThreshold(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="e.g., 20"
                min={0}
                className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
              />
              <p className="mt-1 text-xs text-hud-cream-mute">
                Send notification when score drops below this threshold
              </p>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium text-hud-cream-soft">Notification Channels</p>
              <label className="flex items-center justify-between p-3 bg-hud-bg-mid rounded-lg cursor-pointer border border-hud-bg-elev">
                <div className="flex items-center gap-3">
                  <Bell className="h-5 w-5 text-hud-cream-dim" />
                  <span className="text-sm text-hud-cream-soft">In-App Notification</span>
                </div>
                <input
                  type="checkbox"
                  checked={notifyInApp}
                  onChange={(e) => setNotifyInApp(e.target.checked)}
                  className="rounded text-hud-gold bg-hud-bg-mid border-hud-cream-mute focus:ring-hud-gold"
                />
              </label>
              <label className="flex items-center justify-between p-3 bg-hud-bg-mid rounded-lg cursor-pointer border border-hud-bg-elev">
                <div className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-hud-cream-dim" />
                  <span className="text-sm text-hud-cream-soft">Email Notification</span>
                </div>
                <input
                  type="checkbox"
                  checked={notifyEmail}
                  onChange={(e) => setNotifyEmail(e.target.checked)}
                  className="rounded text-hud-gold bg-hud-bg-mid border-hud-cream-mute focus:ring-hud-gold"
                />
              </label>
              <label className="flex items-center justify-between p-3 bg-hud-bg-mid rounded-lg cursor-pointer border border-hud-bg-elev">
                <div className="flex items-center gap-3">
                  <MessageSquare className="h-5 w-5 text-hud-cream-dim" />
                  <span className="text-sm text-hud-cream-soft">SMS Notification</span>
                </div>
                <input
                  type="checkbox"
                  checked={notifySms}
                  onChange={(e) => setNotifySms(e.target.checked)}
                  className="rounded text-hud-gold bg-hud-bg-mid border-hud-cream-mute focus:ring-hud-gold"
                />
              </label>
            </div>
          </div>
        </div>
      )}

      {selectedModelId && (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg shadow-lg shadow-hud-gold/25 hover:shadow-hud-gold/40 hover:brightness-110 disabled:opacity-50 transition-all"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      )}
    </div>
  );
}
