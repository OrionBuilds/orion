import { useMemo, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Coins, Cpu, Layers, Trophy, Users } from 'lucide-react';
import {
  agentLabel, ago, formatTokens, formatUsd, lastDays, pctChange, pivotCostByDay, type Costs,
} from '../../services/agentOps';
import { Badge, EmptyNote, Panel, RangeToggle, Stat } from './ui';
import { fmtDateTime, shortDay, HUD, SERIES, tooltipStyle } from './format';

const COST_RANGES: Array<{ value: number; label: string }> = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
];

function Table({ head, rows }: { head: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead className="text-[11px] uppercase tracking-wider text-hud-cream-mute">
          <tr>{head.map((h, i) => <th key={h} className={`py-1.5 pr-3 font-medium ${i > 0 ? 'text-right' : ''}`}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-hud-line-soft">
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={`py-1.5 pr-3 ${j > 0 ? 'text-right font-hud-mono text-hud-cream-dim' : 'text-hud-cream'}`}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CostsTab({ costs, range, onRange }: { costs: Costs; range: number; onRange: (d: number) => void }) {
  const days = useMemo(() => lastDays(range), [range]);
  const { data, agents } = useMemo(() => pivotCostByDay(costs.by_day, days), [costs.by_day, days]);
  const t = costs.totals;
  const change = pctChange(Number(costs.mtd.cost_usd), Number(costs.prev_period.cost_usd));

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-hud-cream-mute">
        From the OS's own AI call log (ai_call_usage). API-key calls are priced from token counts at published rates
        (marked estimated); subscription calls show the API-equivalent value the agent reports, not money billed.
        Billed totals from the provider are under Subscriptions &amp; keys.
      </p>
      <RangeToggle value={range} options={COST_RANGES} onChange={onRange} />
    </div>
  );

  if (!costs.first_logged_at) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyNote>
          No AI calls have been logged yet. Metering starts when migration 20261029030000 is applied and the updated edge
          functions are deployed: every Anthropic call made by Clara and the OS's AI features then records its model, tokens
          and estimated cost. FRIDAY runs on the workstation and calls its models through the Claude Code / Codex CLIs, so its
          spend appears once it reports its model-call ledger with the MCP tool <span className="font-hud-mono">agent_usage_report</span>.
          Nothing is shown until real data arrives.
        </EmptyNote>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}

      <div className="grid grid-cols-2 gap-4 rounded-xl border border-hud-line-soft bg-hud-bg-card/70 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={`Spend (${range}d)`} value={formatUsd(Number(t.cost_usd))} hint={`${t.calls.toLocaleString()} calls`} />
        <Stat
          label="Month to date"
          value={formatUsd(Number(costs.mtd.cost_usd))}
          hint={change === null ? `prev. period ${formatUsd(Number(costs.prev_period.cost_usd))}` : `${change > 0 ? '+' : ''}${change}% vs same days last month`}
          tone={change !== null && change > 25 ? 'warn' : 'default'}
        />
        <Stat label="Metered (API keys)" value={formatUsd(Number(t.metered_cost_usd))} hint="billed per token" />
        <Stat label="Subscription value" value={formatUsd(Number(t.subscription_value_usd))} hint="API-equivalent, flat-rate plans" />
        <Stat label="Tokens in / out" value={`${formatTokens(Number(t.input_tokens))} / ${formatTokens(Number(t.output_tokens))}`} hint={`cache read ${formatTokens(Number(t.cache_read_tokens))}`} />
        <Stat label="Unpriced / failed" value={`${t.unpriced_calls} / ${t.error_calls}`} hint={`${t.estimated_calls} estimated`} tone={t.unpriced_calls ? 'warn' : 'default'} />
      </div>

      <Panel title="Spend by day and agent" icon={<Coins size={14} className="text-hud-gold" />}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data}>
            <CartesianGrid stroke={HUD.grid} vertical={false} />
            <XAxis dataKey="day" tickFormatter={shortDay} stroke={HUD.creamMute} fontSize={11} />
            <YAxis stroke={HUD.creamMute} fontSize={11} width={48} tickFormatter={(v) => formatUsd(Number(v))} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => shortDay(String(l))} formatter={(v, name) => [formatUsd(Number(v)), agentLabel(String(name))]} />
            <Legend formatter={(v) => agentLabel(String(v))} wrapperStyle={{ fontSize: 11 }} />
            {agents.map((a, i) => <Bar key={a} dataKey={a} stackId="c" fill={SERIES[i % SERIES.length]} />)}
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By agent" icon={<Users size={14} className="text-hud-gold" />}>
          <Table
            head={['Agent', 'Spend', 'Calls', 'Tokens in/out', 'Cost / run']}
            rows={costs.by_agent.map((a) => [
              agentLabel(a.agent), formatUsd(Number(a.cost_usd)), a.calls,
              `${formatTokens(Number(a.input_tokens))} / ${formatTokens(Number(a.output_tokens))}`,
              a.cost_per_run === null ? <span title="No calls were tied to a scheduled run">—</span> : `${formatUsd(Number(a.cost_per_run))} (${a.runs})`,
            ])}
          />
        </Panel>
        <Panel title="By provider" icon={<Layers size={14} className="text-hud-gold" />}>
          <Table
            head={['Provider', 'Spend', 'Calls', 'Last used']}
            rows={costs.by_provider.map((p) => [
              <span key="p">{p.provider} <Badge tone={p.auth_type === 'subscription' ? 'info' : 'muted'}>{p.auth_type.replace('_', ' ')}</Badge></span>,
              formatUsd(Number(p.cost_usd)), p.calls, ago(p.last_used_at),
            ])}
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By model" icon={<Cpu size={14} className="text-hud-gold" />}>
          <Table
            head={['Model', 'Spend', 'Calls', 'Tokens in/out']}
            rows={costs.by_model.map((m) => [
              <span key="m" className="break-all">{m.model} <span className="text-xs text-hud-cream-mute">{m.provider}</span></span>,
              formatUsd(Number(m.cost_usd)), m.calls, `${formatTokens(Number(m.input_tokens))} / ${formatTokens(Number(m.output_tokens))}`,
            ])}
          />
        </Panel>
        <Panel title="Most expensive tasks" icon={<Trophy size={14} className="text-hud-gold" />}>
          {costs.top_tasks.length === 0 ? <EmptyNote>Nothing yet.</EmptyNote> : (
            <Table
              head={['Task', 'Spend', 'Calls', 'Last']}
              rows={costs.top_tasks.map((x) => [
                <span key="t"><span className="text-xs text-hud-cream-mute">{agentLabel(x.agent)} · </span>{x.label}</span>,
                formatUsd(Number(x.cost_usd)), x.calls, fmtDateTime(x.last_at),
              ])}
            />
          )}
        </Panel>
      </div>

      <Panel title="By feature / source" icon={<Layers size={14} className="text-hud-gold" />}>
        <Table
          head={['Source', 'Spend', 'Calls']}
          rows={costs.by_source.map((s) => [<span key="s"><span className="text-xs text-hud-cream-mute">{agentLabel(s.agent)} · </span>{s.source}</span>, formatUsd(Number(s.cost_usd)), s.calls])}
        />
        <p className="mt-2 text-[11px] text-hud-cream-mute">Logging since {fmtDateTime(costs.first_logged_at)} · times in {costs.timezone}.</p>
      </Panel>
    </div>
  );
}
