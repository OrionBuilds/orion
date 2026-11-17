import { useState, useRef } from 'react';
import {
  X,
  Plus,
  AlertCircle,
  CheckCircle2,
  Upload,
  Trash2,
  Paperclip,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { portalCreateSupportTicket, portalUploadTicketAttachment } from '../../services/clientPortal';
import { TICKET_ATTACHMENT_ACCEPT, friendlyPortalError, ticketAttachmentProblem } from '../../lib/ticketAttachments';
import type {
  SupportTicketServiceCategory,
  SupportTicketRequestType,
  SupportTicketPriority,
  SupportTicketBusinessImpact,
  SupportTicketEnvironment,
  SupportTicketAttachment,
} from '../../types';
import { Portal } from '../shared/Portal';

interface Props {
  projectId: string;
  orgId: string;
  contactName: string;
  contactEmail?: string;
  contactPhone?: string;
  onSuccess: () => void;
  onClose: () => void;
}

const CATEGORY_LABELS: Record<SupportTicketServiceCategory, string> = {
  ai_automation: 'AI Automation System',
  crm_pipeline: 'CRM / Pipeline System',
  content_automation: 'Content Automation Engine',
  integration_api: 'Integration / API System',
  workflow_automation: 'Workflow Automation',
  custom_software: 'Custom Software Development',
  data_analytics: 'Data / Analytics System',
  other: 'Other',
};

const REQUEST_TYPE_LABELS: Record<SupportTicketRequestType, string> = {
  bug_report: 'Bug Report',
  feature_request: 'Feature Request',
  performance_issue: 'Performance Issue',
  configuration_change: 'Configuration Change',
  access_permissions: 'Access / Permissions',
  training_docs: 'Training / Documentation',
  general_inquiry: 'General Inquiry',
};

const PRIORITY_OPTIONS: { value: SupportTicketPriority; label: string; desc: string }[] = [
  { value: 'low', label: 'Low', desc: 'Minor inconvenience' },
  { value: 'medium', label: 'Medium', desc: 'Impacts workflow' },
  { value: 'high', label: 'High', desc: 'Significant disruption' },
  { value: 'critical', label: 'Critical', desc: 'System down / revenue loss' },
];

const IMPACT_LABELS: Record<SupportTicketBusinessImpact, string> = {
  minimal: 'Minimal',
  internal_only: 'Internal Only',
  team_productivity: 'Team Productivity',
  client_facing: 'Client-Facing',
  operations_blocked: 'Operations Blocked',
  revenue_affecting: 'Revenue Affecting',
};

const ENV_LABELS: Record<SupportTicketEnvironment, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
  unknown: 'Unknown',
};

interface FormState {
  title: string;
  service_category: SupportTicketServiceCategory;
  request_type: SupportTicketRequestType;
  priority: SupportTicketPriority;
  description: string;
  steps_to_reproduce: string;
  expected_behavior: string;
  actual_behavior: string;
  affected_area: string;
  affected_feature: string;
  affected_integration: string;
  environment: SupportTicketEnvironment;
  error_messages: string;
  business_impact: SupportTicketBusinessImpact;
  impact_description: string;
  users_affected_count: number;
  workaround_available: boolean;
  preferred_contact_method: string;
  availability_window: string;
  expected_resolution_date: string;
}

const DEFAULT_FORM: FormState = {
  title: '',
  service_category: 'ai_automation',
  request_type: 'bug_report',
  priority: 'medium',
  description: '',
  steps_to_reproduce: '',
  expected_behavior: '',
  actual_behavior: '',
  affected_area: '',
  affected_feature: '',
  affected_integration: '',
  environment: 'production',
  error_messages: '',
  business_impact: 'minimal',
  impact_description: '',
  users_affected_count: 1,
  workaround_available: false,
  preferred_contact_method: 'email',
  availability_window: '',
  expected_resolution_date: '',
};

const MAX_FILES = 5;

export function SubmitSupportTicketModal({
  projectId,
  orgId,
  contactName,
  contactEmail,
  contactPhone,
  onSuccess,
  onClose,
}: Props) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [files, setFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [failedUploads, setFailedUploads] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function updateForm(updates: Partial<FormState>) {
    setForm((f) => ({ ...f, ...updates }));
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;
    // Reject up front what the server would reject later (type / 10 MB), so the
    // client sees why here instead of a failed submission.
    const picked = Array.from(e.target.files);
    setFileErrors(picked.map(ticketAttachmentProblem).filter((p): p is string => p !== null));
    const accepted = picked.filter((f) => ticketAttachmentProblem(f) === null);
    setFiles((prev) => {
      const combined = [...prev, ...accepted];
      return combined.slice(0, MAX_FILES);
    });
    e.target.value = '';
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    if (!form.title.trim() || !form.description.trim()) return;
    setSaving(true);
    setError('');

    try {
      // Uploads and the ticket insert both go through the session-validated
      // edge function now. The old path uploaded straight into the public
      // bucket and inserted with the anon key — both anon policies are dropped
      // (20260824222000 / 20260824223000), and client identity is resolved
      // server-side from the portal session (contactName/contactEmail are
      // display-only here).
      //
      // Attachments are best-effort: one rejected file used to abort the whole
      // submission, so the client lost the ticket over a screenshot. Failed
      // files are listed on the confirmation screen instead.
      const uploadedAttachments: SupportTicketAttachment[] = [];
      const failed: string[] = [];
      for (const file of files) {
        try {
          uploadedAttachments.push(await portalUploadTicketAttachment(projectId, file));
        } catch (uploadErr) {
          failed.push(`${file.name} — ${friendlyPortalError(uploadErr, 'upload failed')}`);
        }
      }

      const ticket = await portalCreateSupportTicket({
        projectId,
        title: form.title,
        serviceCategory: form.service_category,
        requestType: form.request_type,
        priority: form.priority,
        description: form.description,
        stepsToReproduce: form.steps_to_reproduce || undefined,
        expectedBehavior: form.expected_behavior || undefined,
        actualBehavior: form.actual_behavior || undefined,
        affectedArea: form.affected_area || undefined,
        affectedFeature: form.affected_feature || undefined,
        affectedIntegration: form.affected_integration || undefined,
        environment: form.environment,
        browserInfo: navigator.userAgent,
        errorMessages: form.error_messages || undefined,
        attachments: uploadedAttachments,
        businessImpact: form.business_impact,
        impactDescription: form.impact_description || undefined,
        usersAffectedCount: form.users_affected_count,
        workaroundAvailable: form.workaround_available,
        preferredContactMethod: form.preferred_contact_method,
        availabilityWindow: form.availability_window || undefined,
        expectedResolutionDate: form.expected_resolution_date || undefined,
      });

      try {
        const notifyUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/support-ticket-notify`;
        const notifyRes = await fetch(notifyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
            'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ ticket_id: ticket.id, org_id: orgId }),
        });
        const notifyBody = await notifyRes.json().catch(() => null);
        console.log('support-ticket-notify response:', notifyRes.status, notifyBody);
        if (!notifyRes.ok) {
          console.error('support-ticket-notify failed:', notifyRes.status, notifyBody);
        }
      } catch (notifyErr) {
        console.error('support-ticket-notify error:', notifyErr);
      }

      setFailedUploads(failed);
      setSubmitted(true);
      // With failed attachments the client needs time to read which ones — they close it themselves.
      if (!failed.length) setTimeout(() => onSuccess(), 2500);
    } catch (err) {
      setError(friendlyPortalError(err));
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
          <h2 className="text-lg font-bold text-hud-bg-mid mb-2">Ticket Submitted</h2>
          <p className="text-sm text-hud-cream-mute">
            Your support ticket has been submitted and our team has been notified. We'll get back to you shortly.
          </p>
          {failedUploads.length > 0 && (
            <>
              <div className="mt-4 text-left text-sm text-hud-plum bg-hud-plum/10 border border-hud-plum/25 rounded-lg px-3 py-2">
                <p className="font-medium mb-1">These attachments couldn't be added:</p>
                <ul className="list-disc pl-5 space-y-0.5">
                  {failedUploads.map((f) => <li key={f}>{f}</li>)}
                </ul>
                <p className="mt-1">Reply to your ticket email with them and we'll attach them for you.</p>
              </div>
              <button
                onClick={onSuccess}
                className="mt-4 w-full py-2.5 text-sm font-semibold text-hud-bg-deep bg-hud-teal rounded-xl transition-colors"
              >
                Done
              </button>
            </>
          )}
        </div>
      </div></Portal>
    );
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white [color-scheme:light] rounded-2xl shadow-xl w-full max-w-2xl max-h-[90dvh] overflow-y-auto animate-in fade-in zoom-in-95 duration-200">
        <div className="sticky top-0 z-10 bg-white flex items-center justify-between p-6 border-b border-hud-cream rounded-t-2xl">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-hud-teal/15 rounded-xl flex items-center justify-center">
              <AlertCircle className="w-4 h-4 text-hud-teal" />
            </div>
            <h2 className="text-base font-bold text-hud-bg-mid">Submit Support Ticket</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-hud-cream-dim hover:text-hud-cream-mute hover:bg-hud-cream rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="bg-hud-teal/10 border border-hud-teal/15 rounded-xl p-3 text-sm text-hud-teal">
            Submitting as: <strong>{contactName}</strong>
            {contactEmail && <span className="text-hud-teal"> &middot; {contactEmail}</span>}
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">
              Issue Title <span className="text-hud-plum">*</span>
            </label>
            <input
              value={form.title}
              onChange={(e) => updateForm({ title: e.target.value })}
              placeholder="Brief summary of the issue"
              className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal bg-white text-hud-bg-mid placeholder-hud-cream-mute"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Support Category</label>
              <select
                value={form.service_category}
                onChange={(e) => updateForm({ service_category: e.target.value as SupportTicketServiceCategory })}
                className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal text-hud-bg-mid bg-white"
              >
                {Object.entries(CATEGORY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Request Type</label>
              <select
                value={form.request_type}
                onChange={(e) => updateForm({ request_type: e.target.value as SupportTicketRequestType })}
                className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal text-hud-bg-mid bg-white"
              >
                {Object.entries(REQUEST_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-bg-elev mb-2">Priority</label>
            <div className="grid grid-cols-4 gap-2">
              {PRIORITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => updateForm({ priority: opt.value })}
                  className={`p-2.5 rounded-xl border text-center transition-all ${
                    form.priority === opt.value
                      ? opt.value === 'critical'
                        ? 'border-hud-plum bg-hud-plum/10 ring-2 ring-hud-plum/25'
                        : opt.value === 'high'
                        ? 'border-orange-400 bg-orange-50 ring-2 ring-orange-200'
                        : opt.value === 'medium'
                        ? 'border-hud-rust bg-hud-rust/10 ring-2 ring-hud-rust/25'
                        : 'border-hud-cream-dim bg-hud-bg-elev ring-2 ring-hud-cream-soft'
                      : 'border-hud-cream-soft hover:border-hud-cream-soft bg-white'
                  }`}
                >
                  <div className="text-sm font-semibold text-hud-bg-mid">{opt.label}</div>
                  <div className="text-xs text-hud-cream-mute mt-0.5">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">
              Description <span className="text-hud-plum">*</span>
            </label>
            <textarea
              value={form.description}
              onChange={(e) => updateForm({ description: e.target.value })}
              rows={4}
              placeholder="Describe the issue in detail. What is happening? When did it start?"
              className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal resize-none bg-white text-hud-bg-mid placeholder-hud-cream-mute"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">
              Steps to Reproduce <span className="text-hud-cream-dim font-normal">(if applicable)</span>
            </label>
            <textarea
              value={form.steps_to_reproduce}
              onChange={(e) => updateForm({ steps_to_reproduce: e.target.value })}
              rows={3}
              placeholder="1. Go to...&#10;2. Click on...&#10;3. Observe that..."
              className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal resize-none bg-white text-hud-bg-mid placeholder-hud-cream-mute"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Affected Area</label>
              <input
                value={form.affected_area}
                onChange={(e) => updateForm({ affected_area: e.target.value })}
                placeholder="e.g., Dashboard, CRM, Workflows"
                className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal bg-white text-hud-bg-mid placeholder-hud-cream-mute"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Affected Feature</label>
              <input
                value={form.affected_feature}
                onChange={(e) => updateForm({ affected_feature: e.target.value })}
                placeholder="e.g., Email automation, Lead scoring"
                className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal bg-white text-hud-bg-mid placeholder-hud-cream-mute"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">
              Error Messages <span className="text-hud-cream-dim font-normal">(if any)</span>
            </label>
            <textarea
              value={form.error_messages}
              onChange={(e) => updateForm({ error_messages: e.target.value })}
              rows={2}
              placeholder="Paste any error messages you're seeing..."
              className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal resize-none bg-white text-hud-bg-mid placeholder-hud-cream-mute font-mono text-xs"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-bg-elev mb-2">
              Screenshots & Attachments <span className="text-hud-cream-dim font-normal">(max {MAX_FILES})</span>
            </label>
            <div
              onClick={() => files.length < MAX_FILES && fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-4 text-center transition-colors ${
                files.length >= MAX_FILES
                  ? 'border-hud-cream-soft bg-hud-bg-elev cursor-not-allowed'
                  : 'border-hud-cream-soft hover:border-hud-teal hover:bg-hud-teal/30 cursor-pointer'
              }`}
            >
              <Upload className="w-5 h-5 text-hud-cream-dim mx-auto mb-1.5" />
              <p className="text-sm text-hud-cream-mute">
                {files.length >= MAX_FILES ? 'Maximum files reached' : 'Click to upload screenshots or files'}
              </p>
              <p className="text-xs text-hud-cream-dim mt-0.5">PNG, JPG, GIF, WEBP, HEIC, PDF, DOC, TXT, LOG or CSV · up to 10 MB each</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={TICKET_ATTACHMENT_ACCEPT}
              onChange={handleFileSelect}
              className="hidden"
            />
            {fileErrors.length > 0 && (
              <div className="mt-2 text-xs text-hud-plum space-y-0.5">
                {fileErrors.map((msg) => <p key={msg}>{msg}</p>)}
              </div>
            )}
            {files.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {files.map((file, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 bg-hud-bg-elev border border-hud-cream-soft rounded-lg">
                    <Paperclip className="w-3.5 h-3.5 text-hud-cream-dim flex-none" />
                    <span className="text-sm text-hud-cream-soft truncate flex-1">{file.name}</span>
                    <span className="text-xs text-hud-cream-dim flex-none">{(file.size / 1024).toFixed(0)} KB</span>
                    <button
                      onClick={() => removeFile(i)}
                      className="p-1 text-hud-cream-dim hover:text-hud-plum rounded transition-colors flex-none"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Business Impact</label>
              <select
                value={form.business_impact}
                onChange={(e) => updateForm({ business_impact: e.target.value as SupportTicketBusinessImpact })}
                className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal text-hud-bg-mid bg-white"
              >
                {Object.entries(IMPACT_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Environment</label>
              <select
                value={form.environment}
                onChange={(e) => updateForm({ environment: e.target.value as SupportTicketEnvironment })}
                className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal text-hud-bg-mid bg-white"
              >
                {Object.entries(ENV_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm text-hud-cream-mute hover:text-hud-bg-elev font-medium transition-colors"
          >
            {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            {showAdvanced ? 'Hide' : 'Show'} additional details
          </button>

          {showAdvanced && (
            <div className="space-y-4 border-t border-hud-cream pt-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Expected Behavior</label>
                  <textarea
                    value={form.expected_behavior}
                    onChange={(e) => updateForm({ expected_behavior: e.target.value })}
                    rows={2}
                    placeholder="What should happen?"
                    className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal resize-none bg-white text-hud-bg-mid placeholder-hud-cream-mute"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Actual Behavior</label>
                  <textarea
                    value={form.actual_behavior}
                    onChange={(e) => updateForm({ actual_behavior: e.target.value })}
                    rows={2}
                    placeholder="What is actually happening?"
                    className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal resize-none bg-white text-hud-bg-mid placeholder-hud-cream-mute"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Impact Description</label>
                <textarea
                  value={form.impact_description}
                  onChange={(e) => updateForm({ impact_description: e.target.value })}
                  rows={2}
                  placeholder="Describe how this issue impacts your business..."
                  className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal resize-none bg-white text-hud-bg-mid placeholder-hud-cream-mute"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Users Affected</label>
                  <input
                    type="number"
                    min={1}
                    value={form.users_affected_count}
                    onChange={(e) => updateForm({ users_affected_count: parseInt(e.target.value) || 1 })}
                    className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal bg-white text-hud-bg-mid"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Contact Preference</label>
                  <select
                    value={form.preferred_contact_method}
                    onChange={(e) => updateForm({ preferred_contact_method: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal text-hud-bg-mid bg-white"
                  >
                    <option value="email">Email</option>
                    <option value="phone">Phone</option>
                    <option value="portal">Portal</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">Need By Date</label>
                  <input
                    type="date"
                    value={form.expected_resolution_date}
                    onChange={(e) => updateForm({ expected_resolution_date: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal bg-white text-hud-bg-mid"
                  />
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.workaround_available}
                  onChange={(e) => updateForm({ workaround_available: e.target.checked })}
                  className="w-4 h-4 accent-hud-teal rounded"
                />
                <span className="text-sm text-hud-bg-elev">I have a workaround for this issue</span>
              </label>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-hud-plum bg-hud-plum/10 border border-hud-plum/25 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-none" />
              {error}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-white flex gap-3 p-6 border-t border-hud-cream rounded-b-2xl">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 text-sm text-hud-cream-mute bg-hud-cream hover:bg-hud-cream-soft rounded-xl transition-colors font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !form.title.trim() || !form.description.trim()}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-hud-bg-deep bg-hud-teal hover:bg-hud-teal disabled:opacity-50 rounded-xl transition-colors"
          >
            <Plus className="w-4 h-4" />
            {saving ? 'Submitting...' : 'Submit Ticket'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
