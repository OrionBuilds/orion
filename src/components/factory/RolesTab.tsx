import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Search } from 'lucide-react';
import { Badge, EmptyNote, ErrorNote, Panel } from '../agent-health/ui';
import { AGENTS, agentLabel, getRolePrompt, listRoles, setRoleEnabled, type AgentRole } from '../../services/factory';
import { reportBackgroundError } from '../../lib/errors';
import { Switch } from './ui';
import { selectCls, when } from './format';

/** The role library (agent_roles): prompts steps borrow. Prompts load on expand; the owner can switch roles off. */
export function RolesTab({ orgId, canManage, refreshKey }: { orgId: string; canManage: boolean; refreshKey: number }) {
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState('all');
  const [division, setDivision] = useState('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRoles(await listRoles(orgId));
      setPrompts(new Map());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const divisions = useMemo(() => [...new Set(roles.map((r) => r.division))].sort(), [roles]);
  const q = query.trim().toLowerCase();
  const shown = roles.filter((r) => (agent === 'all' || r.default_agent === agent)
    && (division === 'all' || r.division === division)
    && (!q || `${r.name} ${r.slug} ${r.description}`.toLowerCase().includes(q)));

  const expand = async (r: AgentRole) => {
    if (openId === r.id) { setOpenId(null); return; }
    setOpenId(r.id);
    if (prompts.has(r.id)) return;
    try {
      const text = await getRolePrompt(r.id);
      setPrompts((prev) => new Map(prev).set(r.id, text));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggle = async (r: AgentRole, enabled: boolean) => {
    setSaving(r.id);
    try {
      await setRoleEnabled(r.id, enabled);
      setRoles((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled } : x)));
    } catch (err) {
      reportBackgroundError('factory.role')(err);
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  if (loading && !roles.length) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-hud-gold" /></div>;

  return (
    <>
      {error && <ErrorNote message={error} />}
      <Panel title={`Roles (${shown.length}${shown.length !== roles.length ? ` of ${roles.length}` : ''})`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-hud-cream-mute" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search roles" aria-label="Search roles"
                className={`${selectCls} w-40 pl-6`} />
            </label>
            <select value={agent} onChange={(e) => setAgent(e.target.value)} className={selectCls} aria-label="Filter by agent">
              <option value="all">All agents</option>
              {AGENTS.map((a) => <option key={a} value={a}>{agentLabel(a)}</option>)}
            </select>
            <select value={division} onChange={(e) => setDivision(e.target.value)} className={selectCls} aria-label="Filter by division">
              <option value="all">All divisions</option>
              {divisions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>}>
        {shown.length === 0 ? <EmptyNote>{roles.length ? 'No roles match.' : 'The role library is empty.'}</EmptyNote> : (
          <ul className="divide-y divide-hud-line-soft">
            {shown.map((r) => {
              const isOpen = openId === r.id;
              return (
                <li key={r.id} className={`py-2 ${r.enabled ? '' : 'opacity-60'}`}>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => void expand(r)} aria-expanded={isOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      {isOpen ? <ChevronDown size={14} className="shrink-0 text-hud-cream-mute" /> : <ChevronRight size={14} className="shrink-0 text-hud-cream-mute" />}
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-hud-cream">{r.name} <span className="font-hud-mono text-xs text-hud-cream-mute">{r.slug}</span></span>
                        {r.description && <span className="block truncate text-xs text-hud-cream-mute">{r.description}</span>}
                      </span>
                    </button>
                    <span className="hidden shrink-0 items-center gap-1.5 text-xs text-hud-cream-dim md:flex">
                      <Badge>{r.division}</Badge>
                      <Badge tone="info">{agentLabel(r.default_agent)}</Badge>
                      <span>v{r.version}</span>
                      <span className="font-hud-mono text-hud-cream-mute" title={[r.source_repo, r.source_path].filter(Boolean).join(' / ')}>{r.source_sha ? r.source_sha.slice(0, 7) : 'local'}</span>
                    </span>
                    <Switch checked={r.enabled} disabled={!canManage || saving === r.id} label={`${r.name} enabled`} onChange={(v) => void toggle(r, v)} />
                  </div>
                  {isOpen && (
                    <div className="mt-2 pl-6">
                      <div className="mb-1 text-[11px] text-hud-cream-mute">
                        {[r.source_repo, r.source_path].filter(Boolean).join(' / ') || 'local role'} · updated {when(r.updated_at)}
                      </div>
                      {prompts.has(r.id)
                        ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-hud-bg-card p-3 font-hud-mono text-xs text-hud-cream-soft">{prompts.get(r.id) || '(empty prompt)'}</pre>
                        : <Loader2 className="h-4 w-4 animate-spin text-hud-cream-mute" />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
