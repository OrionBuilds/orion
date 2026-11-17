/** Inbox: suggestions extracted from sources, each with the verbatim evidence. Accept, edit then accept, or reject. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '../agent-health/ui';
import { getErrorMessage } from '../../lib/errors';
import { listRegisterDefs, type Engagement, type RegisterDef } from '../../services/caio';
import {
  acceptProposal, listFactDefs, listOpenProposals, rejectProposal, type FactDef, type Proposal,
} from '../../services/caioAutomation';
import { ErrorBox, ToneBadge } from './ui';
import { btnGhost, btnPrimary, inputCls } from './styles';
import { FLAG_LABEL, groupBy, isBulkAcceptable } from './automationLogic';

export interface InboxPanelProps { engagement: Engagement; canManage: boolean }

const CONF_TONE = { high: 'good', medium: 'warn', low: 'bad' } as const;

export function InboxPanel({ engagement, canManage }: InboxPanelProps) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [facts, setFacts] = useState<FactDef[]>([]);
  const [registers, setRegisters] = useState<RegisterDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [bulk, setBulk] = useState<string | null>(null);   // source id awaiting confirmation
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, f, r] = await Promise.all([listOpenProposals(engagement.id), listFactDefs(), listRegisterDefs()]);
      setProposals(p); setFacts(f); setRegisters(r); setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not load the inbox'));
      setProposals((cur) => cur ?? []);
    }
  }, [engagement.id]);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => groupBy(proposals ?? [], (p) => p.source_id), [proposals]);

  const decide = async (id: string, fn: () => Promise<void>) => {
    setBusy(id); setCardErrors((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== id))); setNotice(null);
    try { await fn(); await load(); } catch (e) { setCardErrors((c) => ({ ...c, [id]: getErrorMessage(e, 'Could not save this suggestion') })); } finally { setBusy(null); }
  };

  const acceptAll = async (sourceId: string, list: Proposal[]) => {
    setBulk(null); setBusy(`bulk-${sourceId}`); setNotice(null);
    let ok = 0;
    const errs: Record<string, string> = {};
    for (const p of list) {
      try { await acceptProposal(p.id); ok++; } catch (e) { errs[p.id] = getErrorMessage(e, 'Could not save this suggestion'); }
    }
    setCardErrors((c) => ({ ...c, ...errs }));
    setNotice(`${ok} accepted${Object.keys(errs).length ? `, ${Object.keys(errs).length} need your attention below` : ''}.`);
    setBusy(null);
    await load();
  };

  return (
    <div className="space-y-4">
      {error && <ErrorBox message={error} />}
      {notice && <p className="text-sm text-hud-emerald" role="status">{notice}</p>}
      {proposals === null && <p className="text-sm text-hud-cream-mute" role="status">Loading the inbox...</p>}
      {proposals !== null && proposals.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-hud-line-soft py-10 text-center text-sm text-hud-cream-mute">
          Nothing to review. Suggestions appear here after a source has been read.
        </div>
      )}

      {groups.map((g) => {
        const bulkList = g.items.filter(isBulkAcceptable);
        const title = g.items[0].source?.title ?? 'Source';
        return (
          <Panel key={g.key} title={`${title} (${g.items.length})`}
            actions={canManage && bulkList.length > 0 ? (
              bulk === g.key ? (
                <span className="flex items-center gap-2 text-xs text-hud-cream-soft">
                  Accept {bulkList.length} high-confidence suggestion{bulkList.length === 1 ? '' : 's'}? Legal candidates and unverified public research are left for you.
                  <button type="button" className={btnPrimary} disabled={busy !== null} onClick={() => void acceptAll(g.key, bulkList)}>Yes, accept</button>
                  <button type="button" className={btnGhost} onClick={() => setBulk(null)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className={btnGhost} disabled={busy !== null} onClick={() => setBulk(g.key)}>Accept all high-confidence from this source ({bulkList.length})</button>
              )
            ) : undefined}>
            <ul className="space-y-3">
              {g.items.map((p) => (
                <ProposalCard key={p.id} p={p} facts={facts} registers={registers} canManage={canManage} busy={busy === p.id} disabled={busy !== null}
                  error={cardErrors[p.id]}
                  onAccept={(edit) => void decide(p.id, () => acceptProposal(p.id, edit))}
                  onReject={() => void decide(p.id, () => rejectProposal(p.id))} />
              ))}
            </ul>
          </Panel>
        );
      })}
    </div>
  );
}

function ProposalCard({ p, facts, registers, canManage, busy, disabled, error, onAccept, onReject }: {
  p: Proposal; facts: FactDef[]; registers: RegisterDef[]; canManage: boolean; busy: boolean; disabled: boolean; error?: string;
  onAccept: (edit?: Record<string, unknown>) => void; onReject: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const factDef = p.kind === 'fact' ? facts.find((f) => f.fact_key === p.fact_key) : undefined;
  const reg = p.kind === 'record' ? registers.find((r) => r.register_key === p.register_key) : undefined;
  const fieldLabel = (k: string) => reg?.fields.find((f) => f.field_key === k)?.label ?? k;
  const entries = Object.entries(p.payload ?? {}).map(([k, v]) => [k, String(v ?? '')] as const);

  const startEdit = () => { setDraft(Object.fromEntries(entries)); setEditing(true); };
  const submitEdit = () => {
    const cleaned = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''));
    onAccept(p.kind === 'fact' ? { value: cleaned.value ?? '' } : cleaned);
  };

  return (
    <li className="space-y-2 rounded-lg border border-hud-line-soft bg-hud-bg-card/50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-sm text-white">
          {p.kind === 'fact' ? <>Fact: {factDef?.label ?? p.fact_key}</> : <>New {reg?.title ?? p.register_key} record</>}
          {p.summary && <div className="text-xs font-normal text-hud-cream-dim">{p.summary}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ToneBadge tone={CONF_TONE[p.confidence]}>{p.confidence} confidence</ToneBadge>
          {p.flags.map((f) => <ToneBadge key={f} tone="warn">{FLAG_LABEL[f] ?? f}</ToneBadge>)}
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          {(p.kind === 'fact' ? [['value', draft.value ?? '']] as const : Object.entries(draft)).map(([k, v]) => (
            <div key={k}>
              <label htmlFor={`${p.id}-${k}`} className="mb-1 block text-xs text-hud-cream-dim">{p.kind === 'fact' ? (factDef?.label ?? 'Value') : fieldLabel(k)}</label>
              {String(v).length > 80 || p.kind === 'fact' && factDef?.type === 'longtext'
                ? <textarea id={`${p.id}-${k}`} rows={3} className={inputCls} value={v} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                : <input id={`${p.id}-${k}`} className={inputCls} value={v} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />}
            </div>
          ))}
        </div>
      ) : (
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,12rem)_1fr]">
          {p.kind === 'fact'
            ? <><dt className="text-hud-cream-mute">Value</dt><dd className="break-words text-hud-cream-soft">{String(p.payload?.value ?? '')}</dd></>
            : entries.map(([k, v]) => <div key={k} className="contents"><dt className="text-hud-cream-mute">{fieldLabel(k)}</dt><dd className="break-words text-hud-cream-soft">{v}</dd></div>)}
        </dl>
      )}

      <blockquote className="border-l-2 border-hud-gold/50 pl-3 text-xs text-hud-cream-dim">
        <span className="mb-0.5 block uppercase tracking-wide text-hud-cream-mute">Said in the source</span>
        <mark className="rounded bg-hud-gold/25 px-0.5 text-hud-cream">{p.evidence_quote}</mark>
      </blockquote>

      {error && <ErrorBox message={error} />}

      {canManage && (
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <button type="button" className={btnPrimary} disabled={disabled} onClick={submitEdit}>{busy ? 'Saving...' : 'Save and accept'}</button>
              <button type="button" className={btnGhost} disabled={disabled} onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className={btnPrimary} disabled={disabled} onClick={() => onAccept()}>{busy ? 'Saving...' : 'Accept'}</button>
              <button type="button" className={btnGhost} disabled={disabled} onClick={startEdit}>Edit then accept</button>
              <button type="button" className={btnGhost} disabled={disabled} onClick={onReject}>Reject</button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export default InboxPanel;
