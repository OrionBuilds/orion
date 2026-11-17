import { useEffect, useMemo, useState } from 'react';
import { Download, Save, Trash2, Upload } from 'lucide-react';
import type { HarveyProspect } from '../../services/harvey';
import { stageLabel } from '../../services/harvey';
import {
  applyFilters, deleteSearch, describeFilters, facets, isEmptyFilters, listSearches, prospectsToCsv, saveSearch,
  type HarveySearch, type ProspectFilters,
} from '../../services/harveyGrowth';
import { reportBackgroundError } from '../../lib/errors';
import { ImportModal } from './ImportModal';

const inputCls = 'rounded-md border border-hud-line-soft bg-hud-bg-elev px-2 py-1 text-xs text-hud-cream';

function MultiPick({ label, options, value, onChange, render }: {
  label: string; options: string[]; value: string[] | undefined; onChange: (v: string[]) => void; render?: (v: string) => string;
}) {
  if (options.length === 0) return null;
  const selected = new Set(value ?? []);
  return (
    <fieldset className="min-w-0">
      <legend className="text-[11px] uppercase tracking-wider text-hud-cream-mute">{label}</legend>
      <div className="mt-1 flex max-w-xs flex-wrap gap-1">
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={selected.has(o)}
            onClick={() => onChange(selected.has(o) ? [...selected].filter((x) => x !== o) : [...selected, o])}
            className={`rounded-full border px-2 py-0.5 text-xs ${selected.has(o) ? 'border-hud-gold bg-hud-gold/15 text-hud-cream' : 'border-hud-line-soft text-hud-cream-dim hover:text-hud-cream'}`}>
            {render ? render(o) : o}
          </button>))}
      </div>
    </fieldset>
  );
}

const triState = (v: boolean | null | undefined) => (v == null ? '' : v ? 'yes' : 'no');
const fromTri = (v: string): boolean | null => (v === '' ? null : v === 'yes');

/**
 * Filter bar for the pipeline: saved searches (named ICP cohorts), CSV import and export.
 * Filtering runs here over the prospects HARVEY mirrored to the OS.
 */
export function PipelineTools({ orgId, userId, canManage, prospects, filters, onFilters, activeSearchId, onActiveSearch, onSearches, onNotice }: {
  orgId: string; userId: string; canManage: boolean; prospects: HarveyProspect[];
  filters: ProspectFilters; onFilters: (f: ProspectFilters) => void;
  activeSearchId: string; onActiveSearch: (id: string) => void;
  onSearches?: (s: HarveySearch[]) => void;
  onNotice: (message: string) => void;
}) {
  const [searches, setSearches] = useState<HarveySearch[]>([]);
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await listSearches(orgId);
      setSearches(s);
      onSearches?.(s);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [orgId]);

  const f = useMemo(() => facets(prospects), [prospects]);
  const shown = useMemo(() => applyFilters(prospects, filters), [prospects, filters]);
  const active = searches.find((s) => s.id === activeSearchId);
  const patch = (p: Partial<ProspectFilters>) => { onActiveSearch(''); onFilters({ ...filters, ...p }); };

  const choose = (id: string) => {
    onActiveSearch(id);
    const s = searches.find((x) => x.id === id);
    onFilters(s ? s.filters : {});
  };

  const save = async () => {
    const name = window.prompt('Name this search', active?.name ?? '');
    if (!name) return;
    setError(null);
    try {
      await saveSearch(orgId, userId, name, filters, active && active.name.toLowerCase() === name.trim().toLowerCase() ? active.id : undefined);
      await refresh();
      onNotice(`Saved search "${name.trim()}".`);
    } catch (err) {
      reportBackgroundError('harvey.search.save')(err);
      setError((err as Error).message);
    }
  };

  const remove = async () => {
    if (!active || !window.confirm(`Delete the saved search "${active.name}"? Prospects are not affected.`)) return;
    try {
      await deleteSearch(orgId, active.id);
      onActiveSearch('');
      await refresh();
    } catch (err) {
      reportBackgroundError('harvey.search.delete')(err);
      setError((err as Error).message);
    }
  };

  const exportCsv = () => {
    const blob = new Blob([prospectsToCsv(shown)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `harvey-prospects-${(active?.name ?? 'all').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={activeSearchId} onChange={(e) => choose(e.target.value)} className={inputCls} aria-label="Saved search">
          <option value="">{isEmptyFilters(filters) ? 'All prospects' : 'Custom filter'}</option>
          {searches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input value={filters.text ?? ''} onChange={(e) => patch({ text: e.target.value })} placeholder="Search name, company, title, email"
          className={`${inputCls} w-64`} aria-label="Search prospects" />
        <button type="button" onClick={() => setOpen((o) => !o)} className={`${inputCls} hover:text-hud-cream`} aria-expanded={open}>
          {open ? 'Hide filters' : 'More filters'}
        </button>
        {!isEmptyFilters(filters) && <button type="button" onClick={() => { onActiveSearch(''); onFilters({}); }} className="text-xs text-hud-gold hover:underline">Clear</button>}
        <span className="ml-auto flex items-center gap-2">
          {canManage && !isEmptyFilters(filters) && (
            <button type="button" onClick={() => void save()} className={`${inputCls} inline-flex items-center gap-1 hover:text-hud-cream`}><Save size={12} /> Save search</button>)}
          {canManage && active && (
            <button type="button" onClick={() => void remove()} className={`${inputCls} inline-flex items-center gap-1 text-hud-plum hover:bg-hud-plum/10`} aria-label="Delete saved search"><Trash2 size={12} /></button>)}
          <button type="button" onClick={exportCsv} disabled={shown.length === 0} className={`${inputCls} inline-flex items-center gap-1 hover:text-hud-cream disabled:opacity-50`}><Download size={12} /> Export {shown.length}</button>
          {canManage && <button type="button" onClick={() => setImporting(true)} className={`${inputCls} inline-flex items-center gap-1 hover:text-hud-cream`}><Upload size={12} /> Import CSV</button>}
        </span>
      </div>

      {open && (
        <div className="grid gap-4 rounded-lg border border-hud-line-soft p-3 sm:grid-cols-2 lg:grid-cols-3">
          <MultiPick label="Stage" options={f.stages} value={filters.stages} onChange={(v) => patch({ stages: v })} render={stageLabel} />
          <MultiPick label="Industry" options={f.industries} value={filters.industries} onChange={(v) => patch({ industries: v })} />
          <MultiPick label="Company size" options={f.sizes} value={filters.companySizes} onChange={(v) => patch({ companySizes: v })} />
          <MultiPick label="Source" options={f.sources} value={filters.sources} onChange={(v) => patch({ sources: v })} />
          <label className="text-xs text-hud-cream-dim">Title contains (comma separated)
            <input value={filters.titles ?? ''} onChange={(e) => patch({ titles: e.target.value })} className={`${inputCls} mt-1 w-full`} placeholder="cto, head of data" />
          </label>
          <div className="flex flex-wrap items-end gap-3 text-xs text-hud-cream-dim">
            <label>Min score
              <input type="number" min={0} max={100} value={filters.minScore ?? ''} onChange={(e) => patch({ minScore: e.target.value === '' ? null : Number(e.target.value) })} className={`${inputCls} mt-1 block w-20`} />
            </label>
            <label>Email
              <select value={triState(filters.hasEmail)} onChange={(e) => patch({ hasEmail: fromTri(e.target.value) })} className={`${inputCls} mt-1 block`}>
                <option value="">Any</option><option value="yes">Has email</option><option value="no">No email</option>
              </select>
            </label>
            <label>LinkedIn
              <select value={triState(filters.hasLinkedIn)} onChange={(e) => patch({ hasLinkedIn: fromTri(e.target.value) })} className={`${inputCls} mt-1 block`}>
                <option value="">Any</option><option value="yes">Has profile</option><option value="no">No profile</option>
              </select>
            </label>
          </div>
        </div>)}

      <p className="text-xs text-hud-cream-mute">{shown.length} of {prospects.length} prospects · {describeFilters(filters)}</p>
      {error && <p className="text-sm text-hud-plum">{error}</p>}
      {importing && <ImportModal orgId={orgId} userId={userId} existing={prospects} onClose={() => setImporting(false)} onQueued={onNotice} />}
    </div>
  );
}
