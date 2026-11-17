import { CheckCircle2, CircleDashed, KeyRound, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { ago, formatTokens, formatUsd, type Costs, type ProviderCard, type ProviderUsage } from '../../services/agentOps';
import { Badge, EmptyNote, ErrorNote, Panel, Stat } from './ui';
import { fmtDateTime } from './format';

/** Month-to-date and the same span of the previous month, from a provider's daily cost series. */
function providerMtd(card: ProviderCard, now = new Date()): { mtd: number; prev: number } | null {
  const daily = card.usage?.daily;
  if (!daily || card.usage?.cost_usd === null) return null;
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const monthStart = iso(new Date(Date.UTC(y, m, 1)));
  const prevStart = iso(new Date(Date.UTC(y, m - 1, 1)));
  const prevEnd = iso(new Date(Date.UTC(y, m - 1, d)));
  let mtd = 0, prev = 0;
  for (const row of daily) {
    if (row.day >= monthStart) mtd += row.cost_usd;
    else if (row.day >= prevStart && row.day < prevEnd) prev += row.cost_usd;
  }
  return { mtd, prev };
}

function OurLogs({ card, costs }: { card: ProviderCard; costs: Costs | null }) {
  if (!costs) return null;
  const rows = card.key === 'consumer-subscriptions'
    ? costs.by_provider.filter((p) => p.auth_type === 'subscription')
    : costs.by_provider.filter((p) => p.provider === card.key && p.auth_type !== 'subscription');
  if (card.key === 'elevenlabs') return null; // not model calls; nothing in the call log
  const lastUsed = card.key === 'consumer-subscriptions' ? null : costs.last_used[card.key] ?? null;
  return (
    <div className="mt-3 border-t border-hud-line-soft pt-3">
      <div className="mb-1 text-xs uppercase tracking-wider text-hud-cream-mute">Measured by the OS (last {costs.days} days)</div>
      {rows.length === 0 ? (
        <p className="text-sm text-hud-cream-mute">
          No calls logged{lastUsed ? ` in this window (last used ${ago(lastUsed)})` : ''}.
          {card.key === 'consumer-subscriptions' ? ' FRIDAY has not reported subscription usage yet (MCP agent_usage_report).' : ''}
        </p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={`${r.provider}-${r.auth_type}`} className="flex flex-wrap justify-between gap-2 text-hud-cream-dim">
              <span>{r.provider}{card.key === 'consumer-subscriptions' ? ' (subscription)' : ''} · last used {ago(r.last_used_at)}</span>
              <span className="font-hud-mono text-hud-cream">
                {formatUsd(Number(r.cost_usd))}{card.auth_type === 'subscription' ? ' value' : ''} · {r.calls} calls · {formatTokens(Number(r.input_tokens))} in / {formatTokens(Number(r.output_tokens))} out
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CredentialRow({ c }: { c: ProviderCard['credentials'][number] }) {
  const icon = !c.present
    ? <CircleDashed size={14} className="text-hud-cream-mute" />
    : c.valid === false
      ? <XCircle size={14} className="text-hud-plum" />
      : c.valid === true
        ? <CheckCircle2 size={14} className="text-hud-emerald" />
        : <KeyRound size={14} className="text-hud-cream-dim" />;
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0">
        <div className="text-hud-cream-soft">{c.label}</div>
        <div className="text-[11px] text-hud-cream-mute">
          {c.location} · {c.present ? (c.valid === true ? 'valid' : c.valid === false ? 'rejected by provider' : 'present, not checked') : 'not set'}
          {c.enabled === false && c.present ? ' · disabled in AI Settings' : ''}
        </div>
        {c.error && <div className="text-[11px] text-hud-plum">{c.error}</div>}
      </div>
    </li>
  );
}

function ProviderPanel({ card, costs }: { card: ProviderCard; costs: Costs | null }) {
  const mtd = providerMtd(card);
  const sub = card.subscription;
  return (
    <Panel
      title={<span className="flex items-center gap-2">{card.name} <Badge tone={card.auth_type === 'subscription' ? 'info' : 'muted'}>{card.auth_type === 'subscription' ? 'subscription' : 'API key'}</Badge></span>}
      actions={<span className="text-[11px] text-hud-cream-mute">{card.cached ? 'cached · ' : ''}{fmtDateTime(card.fetched_at)}</span>}
    >
      <ul className="space-y-2">{card.credentials.map((c, i) => <CredentialRow key={i} c={c} />)}</ul>

      <div className="mt-3 rounded-lg bg-hud-bg-elev/60 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-hud-cream-mute">Provider usage API</span>
          {!card.usage_api.available
            ? <Badge tone="muted">none exists</Badge>
            : card.usage_api.configured ? <Badge tone="ok">connected</Badge> : <Badge tone="warn">needs setup</Badge>}
        </div>
        <p className="mt-1 text-xs text-hud-cream-dim">{card.usage_api.note}</p>
        {card.usage_api.available && !card.usage_api.configured && card.usage_api.requires && (
          <p className="mt-1 text-xs text-hud-rust">Requires: {card.usage_api.requires}</p>
        )}
      </div>

      {card.error && <div className="mt-3"><ErrorNote message={card.error} /></div>}

      {card.usage && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Billed MTD" value={mtd ? formatUsd(mtd.mtd) : '—'} hint={mtd ? `prev. period ${formatUsd(mtd.prev)}` : 'no cost data'} />
          <Stat label={`Since ${card.usage.period_start.slice(0, 10)}`} value={formatUsd(card.usage.cost_usd)} />
          <Stat label="Tokens in" value={formatTokens(card.usage.input_tokens)} />
          <Stat label="Tokens out" value={formatTokens(card.usage.output_tokens)} />
        </div>
      )}
      {card.usage && card.usage.by_model.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {card.usage.by_model.slice(0, 8).map((m) => (
            <li key={m.model} className="flex justify-between gap-2 text-hud-cream-dim">
              <span className="truncate">{m.model}</span>
              <span className="font-hud-mono">{formatTokens(m.input_tokens + m.cache_read_tokens + m.cache_write_tokens)} in · {formatTokens(m.output_tokens)} out{m.requests ? ` · ${m.requests} req` : ''}</span>
            </li>
          ))}
        </ul>
      )}

      {sub && (
        <div className="mt-3">
          <div className="flex justify-between text-sm">
            <span className="text-hud-cream-soft">Plan: {sub.tier ?? 'unknown'}{sub.status ? ` (${sub.status})` : ''}</span>
            <span className="font-hud-mono text-hud-cream">{sub.characters_used.toLocaleString()} / {sub.character_limit.toLocaleString()} chars</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded bg-hud-bg-elev">
            <div
              className={sub.character_limit && sub.characters_used / sub.character_limit > 0.85 ? 'h-full bg-hud-plum' : 'h-full bg-hud-gold'}
              style={{ width: `${sub.character_limit ? Math.min(100, (sub.characters_used / sub.character_limit) * 100) : 0}%` }}
            />
          </div>
          {sub.resets_at && <p className="mt-1 text-xs text-hud-cream-mute">Quota resets {fmtDateTime(sub.resets_at)}</p>}
        </div>
      )}

      {typeof card.credits === 'number' && (
        <div className="mt-3"><Stat label="Credits remaining" value={card.credits.toLocaleString()} /></div>
      )}

      <OurLogs card={card} costs={costs} />
    </Panel>
  );
}

export function ProvidersTab({ usage, costs, loading, error, canView, onRefresh }: {
  usage: ProviderUsage | null; costs: Costs | null; loading: boolean; error: string | null; canView: boolean; onRefresh: () => void;
}) {
  if (!canView) {
    return <EmptyNote>Subscriptions and API keys are visible to SuperAdmins and members with the ai_agents.manage permission.</EmptyNote>;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-xs text-hud-cream-mute">
          Every AI connection the OS holds, checked server-side. Keys never leave the server; validity checks are free
          model-list calls. Provider usage is cached for 15 minutes.
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-hud-line-soft px-3 py-1 text-xs text-hud-cream-dim hover:text-hud-cream disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Re-check providers
        </button>
      </div>
      {error && <ErrorNote message={error} />}
      {loading && !usage && <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-hud-gold" /></div>}
      {usage && (
        <div className="grid gap-4 xl:grid-cols-2">
          {usage.providers.map((p) => <ProviderPanel key={p.key} card={p} costs={costs} />)}
        </div>
      )}
    </div>
  );
}
