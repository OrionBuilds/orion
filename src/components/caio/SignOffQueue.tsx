/**
 * Sign-off queue: drafts whose only remaining placeholders are approval fields (approver, reference, dates) and that have no
 * unconfirmed auto-filled values. The owner types the approver, reference and review date; each document is then approved
 * on its own through the normal update, so every database rule applies and one failure does not stop the rest.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '../agent-health/ui';
import { getErrorMessage } from '../../lib/errors';
import { updateDocument, type Engagement } from '../../services/caio';
import { listDraftBodies, listPlaceholderResolvers, type DraftBody } from '../../services/caioAutomation';
import { ErrorBox, ToneBadge } from './ui';
import { btnPrimary, inputCls, labelCls } from './styles';
import { SIGN_OFF_LABEL, applySignOff, signOffCheck, signOffInputBlockers, signOffNeeds, type SignOffKey } from './automationLogic';

export interface SignOffQueueProps { engagement: Engagement; canManage: boolean }

type Outcome = { ok: true } | { ok: false; message: string };

export function SignOffQueue({ canManage, engagement }: SignOffQueueProps) {
  const [docs, setDocs] = useState<DraftBody[] | null>(null);
  const [resolvers, setResolvers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [approver, setApprover] = useState(engagement.executive_sponsor || '');
  const [batchRef, setBatchRef] = useState('');
  const [nextReview, setNextReview] = useState('');
  const [extra, setExtra] = useState<Partial<Record<SignOffKey, string>>>({});
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([listDraftBodies(engagement.id), listPlaceholderResolvers()]);
      setDocs(d); setResolvers(r); setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not load the sign-off queue'));
      setDocs((cur) => cur ?? []);
    }
  }, [engagement.id]);
  useEffect(() => { void load(); }, [load]);

  const eligible = useMemo(() => (docs ?? []).map((d) => ({ doc: d, check: signOffCheck(d, resolvers) })).filter((x) => x.check.eligible), [docs, resolvers]);
  const chosen = eligible.filter((x) => picked[x.doc.id] ?? true);
  const refFor = (id: string) => (refs[id] ?? '').trim() || batchRef.trim();
  const needs = useMemo(() => signOffNeeds(chosen.flatMap((x) => x.check.attestations)), [chosen]);
  const extraKeys = needs.filter((k): k is 'decision' | 'conditions' | 'decisionMaker' | 'note' | 'scope' => ['decision', 'conditions', 'decisionMaker', 'note', 'scope'].includes(k));
  const blockers = [
    ...signOffInputBlockers({ approver, ref: 'x', nextReview, ...extra }, needs),
    ...(chosen.every((x) => refFor(x.doc.id)) ? [] : ['an approval reference for every document']),
  ];

  const run = async () => {
    setRunning(true); setOutcomes({}); setError(null);
    const out: Record<string, Outcome> = {};
    // one at a time: a failure on one document must not stop or hide the others
    for (const { doc } of chosen) {
      try {
        const ref = refFor(doc.id);
        const body = applySignOff(doc.body_html, { approver, ref, nextReview, ...extra });
        await updateDocument(doc.id, { body_html: body, approver_name: approver.trim(), approval_ref: ref, next_review: nextReview, status: 'approved' });
        out[doc.id] = { ok: true };
      } catch (e) {
        out[doc.id] = { ok: false, message: getErrorMessage(e, 'Could not approve') };
      }
      setOutcomes({ ...out });
    }
    setRunning(false);
    await load();
  };

  const title = (d: DraftBody) => `${d.template_number === null ? '' : `${String(d.template_number).padStart(2, '0')} `}${d.title}`;
  const failures = Object.entries(outcomes).filter(([, o]) => !o.ok);

  return (
    <div className="space-y-4">
      {error && <ErrorBox message={error} />}
      {docs === null && <p className="text-sm text-hud-cream-mute" role="status">Loading the sign-off queue...</p>}

      {docs !== null && eligible.length === 0 && Object.keys(outcomes).length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-hud-line-soft py-10 text-center text-sm text-hud-cream-mute">
          No drafts are ready for sign-off. A draft appears here once its only open items are approval fields and every auto-filled value is confirmed.
        </div>
      )}

      {eligible.length > 0 && (
        <Panel title={`Ready for sign-off (${eligible.length})`}>
          <div className="space-y-4">
            <p className="text-sm text-hud-cream-soft">
              Approving locks each document. Type the approver, the approval reference, the next review date and any decision fields shown yourself: nothing is generated for you. Evidence links, test results and other items stay in the document.
              Leave a document's own reference blank to use the batch reference.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div><label htmlFor="so-approver" className={labelCls}>Approver</label>
                <input id="so-approver" className={inputCls} value={approver} onChange={(e) => setApprover(e.target.value)} /></div>
              <div><label htmlFor="so-ref" className={labelCls}>Approval reference (whole batch)</label>
                <input id="so-ref" className={inputCls} value={batchRef} onChange={(e) => setBatchRef(e.target.value)} placeholder="Decision, minute or ticket reference" /></div>
              <div><label htmlFor="so-next" className={labelCls}>Next review date</label>
                <input id="so-next" type="date" className={inputCls} value={nextReview} onChange={(e) => setNextReview(e.target.value)} /></div>
            </div>

            {extraKeys.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {extraKeys.map((k) => (
                  <div key={k}><label htmlFor={`so-${k}`} className={labelCls}>{SIGN_OFF_LABEL[k]}</label>
                    <input id={`so-${k}`} className={inputCls} value={extra[k] ?? ''} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })}
                      placeholder={k === 'decisionMaker' ? `Defaults to ${approver || 'the approver'}` : 'Applies to every document in this batch'} /></div>
                ))}
              </div>
            )}

            <ul className="divide-y divide-hud-line-soft">
              {eligible.map(({ doc, check }) => {
                const o = outcomes[doc.id];
                return (
                  <li key={doc.id} className="flex flex-wrap items-center gap-3 py-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-hud-cream-soft">
                      <input type="checkbox" className="accent-[#c9a24a]" checked={picked[doc.id] ?? true} disabled={running}
                        onChange={(e) => setPicked({ ...picked, [doc.id]: e.target.checked })} aria-label={`Include ${title(doc)}`} />
                      <span className="min-w-0 truncate">{title(doc)}</span>
                    </label>
                    <span className="text-xs text-hud-cream-mute">Fills: {check.attestations.length ? check.attestations.join(', ') : 'nothing to fill'}</span>
                    <input className={`${inputCls} !w-56`} aria-label={`Approval reference for ${title(doc)}`} placeholder="Own reference (optional)" value={refs[doc.id] ?? ''}
                      disabled={running} onChange={(e) => setRefs({ ...refs, [doc.id]: e.target.value })} />
                    {o && (o.ok ? <ToneBadge tone="good">approved</ToneBadge> : <span className="basis-full text-xs text-hud-plum" role="alert">{o.message}</span>)}
                  </li>
                );
              })}
            </ul>

            {blockers.length > 0 && chosen.length > 0 && <p className="text-xs text-hud-cream-mute">Still needed: {blockers.join(', ')}.</p>}
            {canManage ? (
              <button type="button" className={btnPrimary} disabled={running || chosen.length === 0 || blockers.length > 0}
                onClick={() => { if (window.confirm(`Approve ${chosen.length} document${chosen.length === 1 ? '' : 's'}? Approved text is locked.`)) void run(); }}>
                {running ? 'Approving...' : `Approve ${chosen.length} document${chosen.length === 1 ? '' : 's'}`}
              </button>
            ) : <p className="text-xs text-hud-cream-mute">View only: you need CAIO manage access to approve.</p>}
          </div>
        </Panel>
      )}

      {Object.values(outcomes).some((o) => o.ok) && !running && (
        <p className="text-sm text-hud-emerald" role="status">{Object.values(outcomes).filter((o) => o.ok).length} document(s) approved.</p>
      )}
      {failures.length > 0 && !running && (
        <p className="text-sm text-hud-rust" role="status">{failures.length} document{failures.length === 1 ? ' was' : 's were'} not approved. Reasons are shown on each row above.</p>
      )}
    </div>
  );
}

export default SignOffQueue;
