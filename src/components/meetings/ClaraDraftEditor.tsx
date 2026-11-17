import { useState } from 'react';
import { Mail, MessageSquare, Save } from 'lucide-react';
import { type ApprovalQueueItem, claraDraftOf, updateClaraDraft } from '../../services/workflowApprovals';

interface Props {
  item: ApprovalQueueItem;
  onSaved: (draftContent: unknown) => void;
  onError: (message: string) => void;
}

/**
 * Edit a pending Clara draft (e.g. a post-meeting recap) before approving it: subject and body,
 * and optionally drop the send delay so it goes out as soon as it is approved (quiet hours still
 * apply). Renders nothing for payloads that aren't a Clara email/text draft. Key it by the
 * approval id so switching items resets the fields.
 */
export function ClaraDraftEditor({ item, onSaved, onError }: Props) {
  const draft = claraDraftOf(item);
  const [subject, setSubject] = useState(draft?.subject ?? '');
  const [body, setBody] = useState(draft?.body ?? '');
  const [sendNow, setSendNow] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!draft || item.status !== 'pending_approval') return null;
  const isSms = draft.kind === 'sms';
  const to = Array.isArray(draft.to) ? draft.to.join(', ') : draft.to;
  const delayed = draft.send_after && Date.parse(draft.send_after) > Date.now();
  const dirty = body !== draft.body || (!isSms && subject !== (draft.subject ?? '')) || sendNow;

  async function save() {
    if (!body.trim()) return;
    setSaving(true);
    try {
      onSaved(await updateClaraDraft(item, { body, subject: isSms ? undefined : subject, sendNow }));
    } catch {
      onError('Could not save the draft');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider flex items-center gap-1.5">
        {isSms ? <MessageSquare className="w-3.5 h-3.5" /> : <Mail className="w-3.5 h-3.5" />}
        {isSms ? 'Text' : 'Email'} to {to}
      </label>
      {!isSms && (
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
          aria-label="Subject"
        />
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={isSms ? 4 : 10}
        className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
        aria-label="Message"
      />
      {isSms && <p className="text-xs text-hud-cream-mute">{body.length} characters</p>}
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-hud-cream-dim">
          {delayed ? (
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} />
              Send as soon as approved (scheduled for {new Date(draft.send_after!).toLocaleString()})
            </label>
          ) : (
            <span>Sends once approved{draft.respect_quiet_hours ? ', outside quiet hours' : ''}.</span>
          )}
        </div>
        <button
          onClick={save}
          disabled={!dirty || saving || !body.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-hud-cream-soft bg-hud-bg-elev border border-hud-cream-mute rounded-lg hover:bg-hud-cream-mute transition-colors disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? 'Saving…' : 'Save draft'}
        </button>
      </div>
    </div>
  );
}
