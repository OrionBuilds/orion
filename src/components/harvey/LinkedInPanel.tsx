import { useState } from 'react';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Badge, EmptyNote, Panel } from '../agent-health/ui';
import type { HarveyLinkedIn, LinkedInQueueItem } from '../../services/harvey';
import { markLinkedInSent, safeProfileUrl } from '../../services/harveyGrowth';
import { reportBackgroundError } from '../../lib/errors';

const KIND: Record<LinkedInQueueItem['kind'], string> = { connect: 'Connection request', message: 'Message', reply: 'Reply' };

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/**
 * LinkedIn in assist mode: Harvey drafts, the owner approves it in Approvals, then sends it by hand
 * from LinkedIn and presses "Mark sent" here so Harvey records it (caps, stage, follow-up timing).
 * Harvey never touches LinkedIn himself in this mode.
 */
export function LinkedInPanel({ linkedin, orgId, userId, canManage, onChanged }: {
  linkedin: HarveyLinkedIn | undefined;
  orgId: string;
  userId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!linkedin) return <Panel title="LinkedIn"><EmptyNote>HARVEY has not reported LinkedIn status yet.</EmptyNote></Panel>;
  if (linkedin.mode !== 'assist') {
    return (
      <Panel title="LinkedIn">
        <p className="text-sm text-hud-cream-soft">
          {linkedin.mode === 'off' || !linkedin.enabled
            ? 'LinkedIn is switched off for HARVEY. To use it by hand, set channels.linkedin to enabled with mode "assist" in harvey.yaml: he then drafts connection notes and messages, you approve and send them yourself, and they show up here.'
            : 'LinkedIn is in automatic mode, so HARVEY sends on his own inside his limits. The hand-off list below only applies to assist mode.'}
        </p>
      </Panel>
    );
  }

  const queue = (linkedin.queue ?? []).filter((q) => !marked.has(q.outbox_id));

  const copy = async (item: LinkedInQueueItem) => {
    try {
      await navigator.clipboard.writeText(item.body);
      setCopied(item.outbox_id);
      setTimeout(() => setCopied((c) => (c === item.outbox_id ? null : c)), 2000);
    } catch (err) {
      reportBackgroundError('harvey.linkedin.copy')(err);
      setError('Could not copy. Select the text and copy it by hand.');
    }
  };

  const sent = async (item: LinkedInQueueItem) => {
    if (!window.confirm(`Mark this ${KIND[item.kind].toLowerCase()} to ${item.name} as sent? Only do this once you have actually sent it on LinkedIn.`)) return;
    setBusy(item.outbox_id);
    setError(null);
    try {
      await markLinkedInSent(orgId, userId, item.outbox_id);
      setMarked((s) => new Set(s).add(item.outbox_id));
      onChanged();
    } catch (err) {
      reportBackgroundError('harvey.linkedin.sent')(err);
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const l = linkedin;
  return (
    <Panel title={`LinkedIn to send (${queue.length})`}
      actions={<Badge tone="info">assist mode: you send, HARVEY records</Badge>}>
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-hud-cream-dim">
        {l.sent_today && <span>Today: {l.sent_today.connect}/{l.limits?.connects_per_day ?? '?'} connections, {l.sent_today.message}/{l.limits?.messages_per_day ?? '?'} messages</span>}
        {l.weekly_connections_sent != null && <span>This week: {l.weekly_connections_sent}/{l.limits?.connects_per_week ?? '?'} connections</span>}
        {l.tripped_until && <span className="text-hud-plum">Safety stop until {when(l.tripped_until)}</span>}
        {l.disabled && <span className="text-hud-plum">Disabled after LinkedIn pushed back</span>}
      </div>
      {error && <p className="mb-3 text-sm text-hud-plum">{error}</p>}
      {queue.length === 0 ? (
        <EmptyNote>Nothing to send. When HARVEY drafts a LinkedIn note, approve it in Approvals and it appears here.</EmptyNote>
      ) : (
        <ul className="space-y-3">
          {queue.map((q) => {
            const url = safeProfileUrl(q.profile_url);
            return (
              <li key={q.outbox_id} className="rounded-lg border border-hud-line-soft p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-hud-cream">{q.name} <span className="text-hud-cream-mute">· {q.title ? `${q.title}, ` : ''}{q.company}</span></div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-hud-cream-mute">
                      <Badge tone="muted">{KIND[q.kind]}</Badge>
                      {q.approved_at && <span>approved {when(q.approved_at)}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {url
                      ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md border border-hud-line-soft px-2.5 py-1 text-xs text-hud-cream-dim hover:text-hud-cream"><ExternalLink size={12} /> Open profile</a>
                      : <span className="text-xs text-hud-plum" title={q.profile_url}>Profile link is not a LinkedIn address</span>}
                    {canManage && (
                      <button type="button" disabled={busy !== null} onClick={() => void sent(q)}
                        className="inline-flex items-center gap-1 rounded-md border border-hud-emerald/40 px-2.5 py-1 text-xs text-hud-emerald hover:bg-hud-emerald/10 disabled:opacity-50">
                        {busy === q.outbox_id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Mark sent
                      </button>)}
                  </div>
                </div>
                {q.body
                  ? (
                    <div className="mt-2">
                      <p className="whitespace-pre-wrap rounded-md bg-hud-bg-elev/60 p-2 text-sm text-hud-cream-soft">{q.body}</p>
                      <button type="button" onClick={() => void copy(q)} className="mt-1.5 inline-flex items-center gap-1 text-xs text-hud-gold hover:underline">
                        {copied === q.outbox_id ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy text</>}
                      </button>
                    </div>)
                  : <p className="mt-2 text-xs text-hud-cream-mute">No note: send the connection request without one.</p>}
              </li>
            );
          })}
        </ul>)}
    </Panel>
  );
}
