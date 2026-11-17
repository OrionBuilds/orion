/**
 * Contract signing — share actions.
 *
 * Replaces a single "Resend" button that rotated the signing token, copied the link, and toasted
 * "Resent." while sending nothing at all. Three actions now, each labelled with what it actually
 * does, and each reporting the real outcome.
 *
 * The SMS route exists because email deliverability is not something the sender controls: a
 * contract to a client was reported DELIVERED by Resend and still never reached him, and the OS had
 * no second way to get it in front of him.
 */

import { useState, useEffect, useCallback } from 'react';
import { Mail, MessageSquare, Link2, Loader2, Check, AlertTriangle, Inbox } from 'lucide-react';
import {
  resendContractSignatureEmail,
  sendContractSigningLinkBySms,
  regenerateContractSigningLink,
  getContractEmailDeliveryStatus,
  type ContractShareContext,
  type DeliveryStatus,
} from '../../services/contractSignatureShare';
import { reportBackgroundError } from '../../lib/errors';

/**
 * How Resend's verdict is rendered.
 *
 * `delivered` is deliberately NOT phrased as "he got it": Resend only knows the recipient's mail
 * servers accepted the message. Spam, quarantine and corporate gateway rules all happen after that
 * and are invisible. A contract read `delivered` on 2026-08-03 and the client never saw it, so the
 * copy has to keep those two ideas apart.
 */
const EVENT_STYLES: Record<string, { bg: string; text: string; label: string; hint?: string }> = {
  delivered: {
    bg: 'bg-hud-emerald/15', text: 'text-hud-emerald/40', label: 'Delivered',
    hint: 'Their mail server accepted it. Spam or gateway filtering after that is not visible here.',
  },
  bounced: {
    bg: 'bg-hud-plum/15', text: 'text-hud-plum/40', label: 'Bounced',
    hint: 'It was rejected — the address may be wrong. Try the SMS route.',
  },
  complained: {
    bg: 'bg-hud-rust/15', text: 'text-hud-rust/40', label: 'Marked as spam',
    hint: 'The recipient flagged it. Do not resend by email — use SMS or send it yourself.',
  },
  sent: { bg: 'bg-hud-cream-mute/15', text: 'text-hud-cream-soft', label: 'Sent, awaiting delivery' },
  queued: { bg: 'bg-hud-cream-mute/15', text: 'text-hud-cream-soft', label: 'Queued' },
};

type Busy = 'email' | 'sms' | 'link' | null;

interface Props {
  ctx: ContractShareContext;
  /** Prefilled from the linked contact when there is one. */
  defaultPhone?: string;
  onChanged: () => void;
  showToast: (kind: 'success' | 'error', message: string) => void;
}

export function ContractShareActions({ ctx, defaultPhone, onChanged, showToast }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [phone, setPhone] = useState(defaultPhone ?? '');
  const [showSms, setShowSms] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<DeliveryStatus | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(true);

  const refreshDelivery = useCallback(async () => {
    setDeliveryLoading(true);
    setDelivery(await getContractEmailDeliveryStatus(ctx.contract.id));
    setDeliveryLoading(false);
  }, [ctx.contract.id]);

  useEffect(() => { void refreshDelivery(); }, [refreshDelivery]);

  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<{ ok: boolean; signingUrl?: string; error?: string }>) => {
    setBusy(kind);
    try {
      const res = await fn();
      // A link is worth keeping even when the send failed — it is the owner's fallback.
      if (res.signingUrl) setLastLink(res.signingUrl);
      if (res.ok) {
        if (kind === 'email') {
          showToast('success', `Signature request emailed to ${ctx.request.signer_email}`);
          // Resend needs a moment to register the new message before it can be looked up.
          setTimeout(() => { void refreshDelivery(); }, 3000);
        }
        if (kind === 'sms') showToast('success', `Signing link texted to ${phone}`);
        if (kind === 'link') {
          if (res.signingUrl) await navigator.clipboard.writeText(res.signingUrl).catch(reportBackgroundError('ContractShareActions.writeText'));
          showToast('success', 'New signing link generated and copied. Nothing was sent.');
        }
        onChanged();
      } else {
        showToast('error', res.error || 'That did not go through');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev p-5 space-y-4">
      <div>
        <h3 className="font-semibold text-white flex items-center gap-2">
          <Link2 className="w-5 h-5 text-hud-gold-soft" />
          Share for signature
        </h3>
        <p className="text-sm text-hud-cream-dim mt-1">
          Send it again by email, text the link, or copy a link to send yourself.
        </p>
      </div>

      {/*
        What Resend actually says happened to the last signature email. Before this, "sent" was the
        end of the story the OS could tell — a contract was recorded as sent, was genuinely
        delivered, and the client never saw it, and nothing in the UI could distinguish that from a
        bounce or a send that never left.
      */}
      {(deliveryLoading || delivery) && (
        <div className="flex items-start gap-2 text-sm">
          <Inbox className="w-4 h-4 mt-0.5 text-hud-cream-dim shrink-0" />
          {deliveryLoading ? (
            <span className="text-hud-cream-dim">Checking delivery…</span>
          ) : delivery?.status === 'not_sent' || delivery?.status === 'no_request' ? (
            <span className="text-hud-cream-dim">No email send recorded yet.</span>
          ) : (() => {
            const style = delivery?.lastEvent ? EVENT_STYLES[delivery.lastEvent] : undefined;
            return (
              <div className="min-w-0">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${style?.bg ?? 'bg-hud-cream-mute/15'} ${style?.text ?? 'text-hud-cream-soft'}`}>
                  {/* An unrecognised or absent event is shown verbatim / as "no event yet" rather
                      than being rounded up to a friendlier word. */}
                  {style?.label ?? (delivery?.lastEvent || 'Accepted, no delivery event yet')}
                </span>
                {delivery?.lastSentAt && (
                  <span className="text-hud-cream-mute text-xs ml-2">
                    last sent {new Date(delivery.lastSentAt).toLocaleString()}
                  </span>
                )}
                {style?.hint && <p className="text-xs text-hud-cream-dim mt-1">{style.hint}</p>}
              </div>
            );
          })()}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => run('email', () => resendContractSignatureEmail(ctx))}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 px-4 py-2 bg-hud-teal hover:bg-hud-teal disabled:opacity-50 text-hud-bg-deep rounded-lg transition-colors text-sm"
        >
          {busy === 'email' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
          Resend email
        </button>

        <button
          onClick={() => setShowSms((v) => !v)}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 px-4 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50 text-white rounded-lg transition-colors text-sm"
        >
          <MessageSquare className="w-4 h-4" />
          Text the link
        </button>

        <button
          onClick={() => run('link', () => regenerateContractSigningLink(ctx))}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 px-4 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50 text-white rounded-lg transition-colors text-sm"
        >
          {busy === 'link' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
          Copy link
        </button>
      </div>

      {showSms && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 123 4567"
            className="flex-1 min-w-[200px] px-3 py-2 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-white text-sm placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold"
          />
          <button
            onClick={() => run('sms', () => sendContractSigningLinkBySms(ctx, phone))}
            disabled={busy !== null || !phone.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-hud-teal hover:bg-hud-teal disabled:opacity-50 text-hud-bg-deep rounded-lg transition-colors text-sm"
          >
            {busy === 'sms' ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
            Send text
          </button>
        </div>
      )}

      {/*
        Not a disclaimer — a consequence the owner has to know before clicking. Only the hash of the
        signing token is stored, so a link can never be re-read, only replaced. Any link already in
        the client's inbox stops working the moment a new one is issued.
      */}
      <p className="text-xs text-hud-rust/80 flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        Each of these issues a NEW signing link and invalidates the previous one. If the client later
        finds the earlier email, that link will no longer work.
      </p>

      {lastLink && (
        <div className="pt-1">
          <div className="flex items-center gap-2 text-xs text-hud-cream-dim mb-1">
            <Check className="w-3.5 h-3.5 text-hud-emerald" />
            Current signing link
          </div>
          <div className="flex gap-2">
            <input
              readOnly
              value={lastLink}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-hud-cream-soft text-xs font-mono"
            />
            <button
              onClick={() => { navigator.clipboard.writeText(lastLink).catch(reportBackgroundError('ContractShareActions.writeText')); showToast('success', 'Copied'); }}
              className="px-3 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute text-white rounded-lg text-xs transition-colors"
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
