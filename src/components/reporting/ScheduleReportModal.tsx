import { useState } from 'react';
import { X, Calendar, Clock } from 'lucide-react';
import { CADENCE_OPTIONS } from '../../services/aiReportSchedules';
import { Portal } from '../shared/Portal';

interface ScheduleReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (cadenceDays: number) => Promise<void>;
  reportName: string;
}

export function ScheduleReportModal({ isOpen, onClose, onSave, reportName }: ScheduleReportModalProps) {
  const [cadenceDays, setCadenceDays] = useState(30);
  const [customDays, setCustomDays] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  if (!isOpen) return null;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const days = isCustom ? parseInt(customDays, 10) : cadenceDays;
      if (!days || days < 1) return;
      await onSave(days);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const nextRunDate = new Date(Date.now() + (isCustom ? parseInt(customDays, 10) || 30 : cadenceDays) * 86400000);

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-hud-bg-mid border border-hud-bg-elev rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-6 border-b border-hud-bg-elev/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-hud-gold/10 border border-hud-gold/20 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-hud-gold-soft" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Schedule Report</h2>
              <p className="text-xs text-hud-cream-dim mt-0.5">Auto-generate on a recurring basis</p>
            </div>
          </div>
          <button onClick={onClose} className="text-hud-cream-dim hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Report</label>
            <p className="text-sm text-hud-cream-dim truncate">{reportName}</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Frequency</label>
            <div className="space-y-2">
              {CADENCE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => { setCadenceDays(opt.value); setIsCustom(false); }}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-all text-sm ${
                    !isCustom && cadenceDays === opt.value
                      ? 'bg-hud-gold/10 border-hud-gold/30 text-hud-gold-soft'
                      : 'bg-hud-bg-card/50 border-hud-bg-elev text-hud-cream-soft hover:border-hud-cream-mute'
                  } ${opt.value === 30 ? 'ring-1 ring-hud-gold/10' : ''}`}
                >
                  <div className="flex items-center justify-between">
                    <span>{opt.label}</span>
                    {opt.value === 30 && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-hud-gold/10 text-hud-gold-soft border border-hud-gold/20">
                        Recommended
                      </span>
                    )}
                  </div>
                </button>
              ))}
              <button
                onClick={() => setIsCustom(true)}
                className={`w-full text-left px-4 py-3 rounded-lg border transition-all text-sm ${
                  isCustom
                    ? 'bg-hud-gold/10 border-hud-gold/30 text-hud-gold-soft'
                    : 'bg-hud-bg-card/50 border-hud-bg-elev text-hud-cream-soft hover:border-hud-cream-mute'
                }`}
              >
                Custom interval
              </button>
              {isCustom && (
                <div className="flex items-center gap-2 pl-4">
                  <span className="text-sm text-hud-cream-dim">Every</span>
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={customDays}
                    onChange={(e) => setCustomDays(e.target.value)}
                    placeholder="30"
                    className="w-20 px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold/40"
                  />
                  <span className="text-sm text-hud-cream-dim">days</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 px-4 py-3 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev/50">
            <Clock className="w-4 h-4 text-hud-cream-dim" />
            <span className="text-sm text-hud-cream-dim">
              Next report: <span className="text-hud-cream-soft">{nextRunDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </span>
          </div>

          <p className="text-xs text-hud-cream-mute">
            Reports are stored automatically. You will receive an in-app notification when each report is ready.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 p-6 border-t border-hud-bg-elev/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-hud-cream-soft hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || (isCustom && (!customDays || parseInt(customDays, 10) < 1))}
            className="px-5 py-2 bg-hud-gold-deep hover:bg-hud-gold disabled:opacity-50 disabled:cursor-not-allowed text-white hover:text-hud-bg-deep text-sm font-medium rounded-lg transition-colors"
          >
            {isSaving ? 'Scheduling...' : 'Schedule'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
