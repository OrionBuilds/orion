import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RotateCcw, AlertTriangle, X } from 'lucide-react';
import { agentLabel } from '../../services/agentOps';
import { groupStopped, listStoppedRequests, ownerRequestAction, type StoppedGroup, type StoppedRequest } from '../../services/agentRequests';
import { useToast } from '../../contexts/ToastContext';
import { Badge, ErrorNote, Panel } from './ui';
import { fmtDateTime } from './format';

type Action = 'retry' | 'dismiss';
/** A second tap within this long confirms an action on more than one request. */
const CONFIRM_MS = 5000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : (e as { message?: string })?.message) || 'unknown error';

function when(g: StoppedGroup): string {
  const first = fmtDateTime(g.first), last = fmtDateTime(g.last);
  return g.ids.length === 1 || first === last ? last : `${first} to ${last}`;
}

/**
 * Work this agent could not finish: failed requests, and questions too old to answer. Nothing here moves again
 * on its own, so the owner decides: hand it back to the agent, or close it. Renders nothing when there is none.
 */
export function StoppedRequests({ orgId, agentUserId, agentSlug, canManage, onChanged }: {
  orgId: string; agentUserId: string; agentSlug: string; canManage: boolean; onChanged?: () => void;
}) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<StoppedRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<number | null>(null);
  const name = agentLabel(agentSlug);

  const load = useCallback(async () => {
    try {
      setRows(await listStoppedRequests(orgId, agentUserId));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [orgId, agentUserId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (armTimer.current) window.clearTimeout(armTimer.current); }, []);

  const groups = useMemo(() => groupStopped(rows ?? []), [rows]);

  const act = async (g: StoppedGroup, action: Action) => {
    if (busy) return;
    const token = `${action}:${g.key}`;
    // More than one request: the first tap arms the button, the second does it.
    if (g.ids.length > 1 && armed !== token) {
      setArmed(token);
      if (armTimer.current) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(null), CONFIRM_MS);
      return;
    }
    setArmed(null);
    setBusy(token);
    try {
      const res = await ownerRequestAction(g.ids, action);
      const moved = action === 'retry' ? res.retried : res.dismissed;
      const left = res.skipped ? ` ${plural(res.skipped, 'request')} had already moved on and ${res.skipped === 1 ? 'was' : 'were'} left alone.` : '';
      if (action === 'retry') {
        showToast(moved ? 'success' : 'error', moved ? `Handed back to ${name}` : 'Nothing to retry',
          `${plural(moved, 'request')} back in ${name}'s queue${moved > 3 ? '; it works through them a few at a time' : ''}.${left}`);
      } else {
        showToast(moved ? 'success' : 'error', moved ? 'Dismissed' : 'Nothing to dismiss', `${plural(moved, 'request')} closed. Nothing runs.${left}`);
      }
      await load();
      onChanged?.();
    } catch (e) {
      showToast('error', action === 'retry' ? "Couldn't retry" : "Couldn't dismiss", `${g.title}: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (error && !rows) return <ErrorNote message={`Couldn't load the requests ${name} could not finish: ${error}`} />;
  if (!rows || rows.length === 0) return null;

  return (
    <Panel title={`Couldn't finish (${rows.length})`} icon={<AlertTriangle size={14} className="text-hud-rust" />}>
      <p className="mb-3 text-xs text-hud-cream-mute">
        These stopped and will not move again on their own. Retry hands the work back to {name}; dismiss closes it and nothing runs.
      </p>
      {error && <ErrorNote message={`Refresh failed: ${error}`} />}
      <ul className="divide-y divide-hud-line-soft" data-testid="stopped-requests">
        {groups.map((g) => {
          const n = g.ids.length;
          const question = g.status === 'needs_input';
          const retryToken = `retry:${g.key}`, dismissToken = `dismiss:${g.key}`;
          return (
            <li key={g.key} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="break-words text-sm text-hud-cream">
                    {g.title}{n > 1 && <span className="ml-1.5 font-hud-mono text-hud-cream-dim">×{n}</span>}
                  </div>
                  <div className={`mt-0.5 break-words text-xs ${question ? 'text-hud-cream-dim' : 'text-hud-plum'}`}>
                    {question ? `Asked and never answered: ${g.reason}` : g.reason}
                  </div>
                  {g.detail && <div className="mt-0.5 line-clamp-2 break-words text-xs text-hud-cream-mute">{g.detail}</div>}
                  <div className="mt-0.5 text-xs text-hud-cream-mute">{when(g)}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge tone={question ? 'warn' : 'bad'}>{question ? 'stale question' : 'failed'}</Badge>
                  {g.playbook && <Badge>{g.playbook}</Badge>}
                </div>
              </div>
              {canManage && (
                <div className="mt-2 flex gap-2">
                  {!question && (
                    <button
                      type="button" disabled={!!busy} onClick={() => void act(g, 'retry')} data-testid="stopped-retry"
                      className={`inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-60 touch-manipulation sm:flex-none ${
                        armed === retryToken ? 'bg-hud-rust text-hud-bg-deep' : 'bg-hud-gold text-hud-bg-deep'}`}
                    >
                      {busy === retryToken ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                      {armed === retryToken ? `Tap again: retry all ${n}` : n > 1 ? `Retry all ${n}` : 'Retry'}
                    </button>
                  )}
                  <button
                    type="button" disabled={!!busy} onClick={() => void act(g, 'dismiss')} data-testid="stopped-dismiss"
                    className={`inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium disabled:opacity-60 touch-manipulation sm:flex-none ${
                      armed === dismissToken ? 'border-hud-rust text-hud-rust' : 'border-hud-line-soft text-hud-cream-dim'}`}
                  >
                    {busy === dismissToken ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                    {armed === dismissToken ? `Tap again: dismiss all ${n}` : n > 1 ? `Dismiss all ${n}` : 'Dismiss'}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
