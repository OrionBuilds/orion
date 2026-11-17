import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ClipboardCheck, Loader2, RotateCcw, SkipForward, XCircle } from 'lucide-react';
import { Drawer } from '../layouts';
import { Badge, EmptyNote, ErrorNote } from '../agent-health/ui';
import { agentLabel, canRetry, getStepRun, statusLabel, stepAction, stepTone, type BoardStep, type StepRun } from '../../services/factory';
import { reportBackgroundError } from '../../lib/errors';
import { Markdown } from './ui';
import { when } from './format';

/** One playbook_step_runs row: what the agent produced, its gate checks and evidence; retry / skip. */
export function StepDrawer({ step, runLabel, canManage, onClose, onChanged }: {
  step: BoardStep | null; runLabel: string; canManage: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [row, setRow] = useState<StepRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      setRow(await getStepRun(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Keyed by id: the board re-polls and hands us a fresh step object every 30 s.
  const stepId = step?.id;
  useEffect(() => {
    setRow(null);
    if (stepId) void load(stepId);
  }, [stepId, load]);

  const act = async (action: 'retry' | 'skip') => {
    if (!step) return;
    if (action === 'skip' && !window.confirm(`Skip "${step.title}"? It counts as finished and the playbook moves on without it.`)) return;
    setBusy(true);
    try {
      await stepAction(step.id, action);
      await load(step.id);
      onChanged();
    } catch (err) {
      reportBackgroundError('factory.stepAction')(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const status = row?.status ?? step?.status ?? 'queued';
  const gate = row?.gate ?? step?.gate ?? null;
  const evidence = Array.isArray(row?.evidence) ? row!.evidence : [];
  const approvalId = row?.approval_id ?? step?.approval_id ?? null;

  return (
    <Drawer open={!!step} onClose={onClose} size="xl" title={step?.title ?? ''} subtitle={runLabel}
      footer={step && ((canManage && canRetry(status)) || approvalId) ? (
        <div className="flex flex-wrap items-center gap-2">
          {canManage && canRetry(status) && (
            <>
              <button type="button" disabled={busy} onClick={() => void act('retry')}
                className="inline-flex items-center gap-1.5 rounded-md border border-hud-emerald/40 px-3 py-1.5 text-sm text-hud-emerald hover:bg-hud-emerald/10 disabled:opacity-50"><RotateCcw size={14} /> Retry</button>
              <button type="button" disabled={busy} onClick={() => void act('skip')}
                className="inline-flex items-center gap-1.5 rounded-md border border-hud-line-soft px-3 py-1.5 text-sm text-hud-cream-dim hover:text-hud-cream disabled:opacity-50"><SkipForward size={14} /> Skip</button>
            </>
          )}
          {approvalId && (
            <Link to="/automation/approvals" className="inline-flex items-center gap-1.5 rounded-md border border-hud-gold/40 px-3 py-1.5 text-sm text-hud-gold hover:bg-hud-gold/10">
              <ClipboardCheck size={14} /> Open approval
            </Link>
          )}
          {busy && <Loader2 className="h-4 w-4 animate-spin text-hud-cream-dim" />}
        </div>
      ) : undefined}>
      {step && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-hud-cream-dim">
            <Badge tone={stepTone(status)}>{statusLabel(status)}</Badge>
            <span>{agentLabel(step.agent)}</span>
            {(row?.role_slug ?? step.role) && <span>· {row?.role_slug ?? step.role}{row?.role_version ? ` v${row.role_version}` : ''}</span>}
            {step.stage && <span>· {step.stage}</span>}
            <span>· attempt {row?.attempts ?? step.attempts}</span>
            {!step.required && <Badge>optional</Badge>}
            <span className="ml-auto text-hud-cream-mute">updated {when(row?.updated_at ?? step.updated_at)}</span>
          </div>

          {error && <ErrorNote message={error} />}
          {(row?.error ?? step.error) && (
            <section>
              <h4 className="mb-1 text-[11px] uppercase tracking-wider text-hud-cream-mute">Error</h4>
              <pre className="whitespace-pre-wrap rounded-lg border border-hud-plum/30 bg-hud-plum/10 p-3 font-hud-mono text-xs text-hud-plum">{row?.error ?? step.error}</pre>
            </section>
          )}

          {gate && Array.isArray(gate.checks) && (
            <section>
              <h4 className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-wider text-hud-cream-mute">
                Gate <Badge tone={gate.passed ? 'ok' : 'bad'}>{gate.passed ? 'passed' : 'not met'}</Badge>
              </h4>
              <ul className="space-y-1.5 text-sm">
                {gate.checks.map((c, i) => (
                  <li key={i} className="flex items-start gap-2">
                    {c.met ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-hud-emerald" aria-label="met" />
                      : <XCircle size={14} className="mt-0.5 shrink-0 text-hud-plum" aria-label="not met" />}
                    <span className="text-hud-cream-soft">{c.criterion}{c.note && <span className="text-hud-cream-mute"> · {c.note}</span>}</span>
                  </li>))}
              </ul>
            </section>
          )}

          <section>
            <h4 className="mb-1.5 text-[11px] uppercase tracking-wider text-hud-cream-mute">Output</h4>
            {loading && !row ? <Loader2 className="h-5 w-5 animate-spin text-hud-cream-mute" />
              : row?.output ? <Markdown>{row.output}</Markdown>
                : <EmptyNote>No output yet.</EmptyNote>}
          </section>

          {evidence.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-[11px] uppercase tracking-wider text-hud-cream-mute">Evidence</h4>
              <ul className="space-y-1 text-sm">
                {evidence.map((e, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Badge tone="info">{e.source}</Badge>
                    {/^https?:\/\//.test(e.ref)
                      ? <a href={e.ref} target="_blank" rel="noopener noreferrer" className="break-all text-hud-teal hover:underline">{e.ref}</a>
                      : <span className="break-all font-hud-mono text-xs text-hud-cream-soft">{e.ref}</span>}
                  </li>))}
              </ul>
            </section>
          )}

          {row?.draft && Object.keys(row.draft).length > 0 && (
            <section>
              <h4 className="mb-1.5 text-[11px] uppercase tracking-wider text-hud-cream-mute">Draft</h4>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-hud-bg-card p-3 font-hud-mono text-xs text-hud-cream-soft">{JSON.stringify(row.draft, null, 2)}</pre>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
