import { useState } from 'react';
import { X, Plus, AlertCircle, CheckCircle2 } from 'lucide-react';
import { portalCreateChangeRequest } from '../../services/clientPortal';
import type { ProjectChangeRequestType, ProjectChangeRequestPriority } from '../../types';
import { Portal } from '../shared/Portal';

interface Props {
  projectId: string;
  orgId: string;
  contactName: string;
  contactEmail?: string;
  onSuccess: () => void;
  onClose: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  scope: 'Scope Change',
  timeline: 'Timeline Adjustment',
  design: 'Design Change',
  feature: 'New Feature',
  bugfix: 'Bug Fix',
  support: 'Support Request',
  other: 'Other',
};

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export function SubmitChangeRequestModal({ projectId, orgId, contactName, contactEmail, onSuccess, onClose }: Props) {
  const [form, setForm] = useState({
    title: '',
    request_type: 'scope' as ProjectChangeRequestType,
    priority: 'medium' as ProjectChangeRequestPriority,
    description: '',
    requested_due_date: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit() {
    if (!form.title.trim() || !form.description.trim()) return;
    setSaving(true);
    setError('');
    try {
      // Session-validated edge write. The old path inserted directly with the
      // anon key and stopped working when the token-blind anon INSERT policies
      // were dropped (20260824222000); identity now comes from the portal
      // session server-side, so contactName/contactEmail are display-only here.
      const request = await portalCreateChangeRequest({
        projectId,
        title: form.title,
        requestType: form.request_type,
        priority: form.priority,
        description: form.description,
        requestedDueDate: form.requested_due_date || undefined,
      });

      try {
        const notifyUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/change-request-notify`;
        const notifyRes = await fetch(notifyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
            'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ request_id: request.id, org_id: orgId }),
        });
        const notifyBody = await notifyRes.json().catch(() => null);
        console.log('change-request-notify response:', notifyRes.status, notifyBody);
      } catch (notifyErr) {
        console.error('change-request-notify error:', notifyErr);
      }

      setSubmitted(true);
      setTimeout(() => {
        onSuccess();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (submitted) {
    return (
      <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/40" />
        <div className="relative bg-white [color-scheme:light] rounded-2xl shadow-xl w-full max-w-md p-8 text-center animate-in fade-in zoom-in-95 duration-200">
          <div className="w-14 h-14 bg-hud-emerald/15 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-7 h-7 text-hud-emerald-dim" />
          </div>
          <h2 className="text-lg font-bold text-hud-bg-mid mb-2">Request Submitted</h2>
          <p className="text-sm text-hud-cream-mute">
            Your change request has been submitted and the project team has been notified.
          </p>
        </div>
      </div></Portal>
    );
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white [color-scheme:light] rounded-2xl shadow-xl w-full max-w-lg max-h-[90dvh] overflow-y-auto animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between p-6 border-b border-hud-cream">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center">
              <Plus className="w-4 h-4 text-blue-600" />
            </div>
            <h2 className="text-base font-bold text-hud-bg-mid">Submit Change Request</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-hud-cream-dim hover:text-hud-cream-mute hover:bg-hud-cream rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-700">
            Submitting as: <strong>{contactName}</strong>
            {contactEmail && <span className="text-blue-500"> &middot; {contactEmail}</span>}
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">
              Title <span className="text-hud-plum">*</span>
            </label>
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Brief description of the change needed"
              className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 bg-white text-hud-bg-mid placeholder-hud-cream-mute"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Change Type</label>
              <select
                value={form.request_type}
                onChange={(e) => setForm((f) => ({ ...f, request_type: e.target.value as ProjectChangeRequestType }))}
                className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-hud-bg-mid bg-white"
              >
                {Object.entries(TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Priority</label>
              <select
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as ProjectChangeRequestPriority }))}
                className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-hud-bg-mid bg-white"
              >
                {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">
              Description <span className="text-hud-plum">*</span>
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={4}
              placeholder="Describe the change in detail. Include what you need changed, why, and any relevant context..."
              className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 resize-none bg-white text-hud-bg-mid placeholder-hud-cream-mute"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">
              Requested By Date <span className="text-hud-cream-dim font-normal">(optional)</span>
            </label>
            <input
              type="date"
              value={form.requested_due_date}
              onChange={(e) => setForm((f) => ({ ...f, requested_due_date: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 bg-white text-hud-bg-mid"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-hud-plum bg-hud-plum/10 border border-hud-plum/25 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-none" />
              {error}
            </div>
          )}
        </div>

        <div className="flex gap-3 p-6 border-t border-hud-cream">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 text-sm text-hud-cream-mute bg-hud-cream hover:bg-hud-cream-soft rounded-xl transition-colors font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !form.title.trim() || !form.description.trim()}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-xl transition-colors"
          >
            <Plus className="w-4 h-4" />
            {saving ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
