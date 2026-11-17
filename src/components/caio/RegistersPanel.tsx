/** Registers tab of the CAIO engagement: the 17 registers as sub-tabs, a filterable table, add / edit / import / export. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, Eye, EyeOff, Plus, Upload } from 'lucide-react';
import {
  listRecords, listRegisterDefs, recordsToCsv, setRegisterClientVisible, todayIso,
  type CaioRecord, type Engagement, type RegisterDef,
} from '../../services/caio';
import { ErrorBox } from './ui';
import { RegisterTable } from './RegisterTable';
import { RecordDrawer } from './RecordDrawer';
import { CsvImportModal } from './CsvImportModal';
import {
  distinctValues, exportFileName, filterRecords, filtersActive, NO_FILTERS, pageCount, pageSlice, pickColumns, sortRecords,
  type RecordFilters, type SortDir, type SortKey,
} from './registerView';

export interface RegistersPanelProps { engagement: Engagement; canManage: boolean; initialRegister?: string }

const selectCls = 'rounded-lg border border-hud-line-soft bg-hud-bg-card px-3 py-2 text-sm text-white focus:border-hud-gold focus:outline-none';
const btnCls = 'inline-flex items-center gap-1.5 rounded-lg border border-hud-line-soft px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-card disabled:cursor-not-allowed disabled:opacity-50';

export function RegistersPanel({ engagement, canManage, initialRegister }: RegistersPanelProps) {
  const [params, setParams] = useSearchParams();
  const [defs, setDefs] = useState<RegisterDef[] | null>(null);
  const [allRecords, setAllRecords] = useState<CaioRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<RecordFilters>(NO_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>('record_key');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);
  // drawer: undefined = closed, null = new record, record = edit/read
  const [drawer, setDrawer] = useState<CaioRecord | null | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([listRegisterDefs(), listRecords(engagement.id)]);
      setDefs(d);
      setAllRecords(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [engagement.id]);

  useEffect(() => { void load(); }, [load]);

  const selectedKey = params.get('register') ?? initialRegister ?? defs?.[0]?.register_key ?? '';
  const def = defs?.find((d) => d.register_key === selectedKey) ?? defs?.[0] ?? null;

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of allRecords ?? []) out[r.register_key] = (out[r.register_key] ?? 0) + 1;
    return out;
  }, [allRecords]);

  const records = useMemo(() => (def ? (allRecords ?? []).filter((r) => r.register_key === def.register_key) : []), [allRecords, def]);
  const columns = useMemo(() => (def ? pickColumns(def) : []), [def]);
  const today = todayIso();
  const filtered = useMemo(() => sortRecords(filterRecords(records, filters, today), sortKey, sortDir), [records, filters, today, sortKey, sortDir]);
  const pages = pageCount(filtered.length);
  const safePage = Math.min(page, pages - 1);
  const visibleRows = pageSlice(filtered, safePage);
  const hasStatus = !!def?.fields.some((f) => f.promote_as === 'status');
  const hasOwner = !!def?.fields.some((f) => f.promote_as === 'owner');
  const hasDue = !!def?.fields.some((f) => f.is_due);
  const active = filtersActive(filters);
  const shownToClient = records.filter((r) => r.client_visible).length;

  const selectRegister = (key: string) => {
    const next = new URLSearchParams(params);
    next.set('register', key);
    setParams(next, { replace: true });
    setFilters(NO_FILTERS);
    setPage(0);
    setDrawer(undefined);
  };
  const setFilter = (patch: Partial<RecordFilters>) => { setFilters((f) => ({ ...f, ...patch })); setPage(0); };
  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const exportCsv = () => {
    if (!def) return;
    const blob = new Blob([`\uFEFF${recordsToCsv(def, filtered)}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(engagement.engagement_code, def.register_key, today);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleWholeRegister = async () => {
    if (!def || !records.length) return;
    const show = shownToClient < records.length;
    const msg = show
      ? `Show all ${records.length} rows of ${def.title} to the client? They only see them while this engagement's client portal is switched on. Fields marked internal only stay hidden.`
      : `Hide all ${records.length} rows of ${def.title} from the client?`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await setRegisterClientVisible(engagement.id, def.register_key, show);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !defs) return <ErrorBox message={error} />;
  if (!defs || !allRecords) return <div role="status" className="py-8 text-center text-sm text-hud-cream-mute">Loading registers…</div>;
  if (!def) return <div className="py-8 text-center text-sm text-hud-cream-mute">No registers are defined yet.</div>;

  const allShown = records.length > 0 && shownToClient === records.length;

  return (
    <div className="space-y-4">
      {error && <ErrorBox message={error} />}

      <div role="tablist" aria-label="Registers" className="flex gap-1 overflow-x-auto border-b border-hud-bg-elev pb-px">
        {defs.map((d) => {
          const on = d.register_key === def.register_key;
          return (
            <button key={d.register_key} type="button" role="tab" aria-selected={on} onClick={() => selectRegister(d.register_key)}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${on ? 'border-hud-gold text-white' : 'border-transparent text-hud-cream-dim hover:text-hud-cream-soft'}`}>
              {d.title}
              <span className="rounded-full bg-hud-bg-elev px-1.5 text-[11px] text-hud-cream-mute">{counts[d.register_key] ?? 0}</span>
            </button>
          );
        })}
      </div>
      <p className="text-sm text-hud-cream-dim">{def.purpose}</p>

      <div className="flex flex-wrap items-center gap-2">
        <input type="search" value={filters.search} onChange={(e) => setFilter({ search: e.target.value })} placeholder="Search this register"
          aria-label="Search this register" className={`${selectCls} min-w-[12rem] flex-1`} />
        {hasStatus && (
          <select aria-label="Filter by status" value={filters.status} onChange={(e) => setFilter({ status: e.target.value })} className={selectCls}>
            <option value="">All statuses</option>
            {distinctValues(records, 'status').map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {hasOwner && (
          <select aria-label="Filter by owner" value={filters.owner} onChange={(e) => setFilter({ owner: e.target.value })} className={selectCls}>
            <option value="">All owners</option>
            {distinctValues(records, 'owner_name').map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {hasDue && (
          <label className="inline-flex items-center gap-1.5 text-sm text-hud-cream-soft">
            <input type="checkbox" checked={filters.overdueOnly} onChange={(e) => setFilter({ overdueOnly: e.target.checked })} />Overdue only
          </label>
        )}
        <label className="inline-flex items-center gap-1.5 text-sm text-hud-cream-soft">
          <input type="checkbox" checked={filters.clientOnly} onChange={(e) => setFilter({ clientOnly: e.target.checked })} />Client-visible only
        </label>
        {active && <button type="button" onClick={() => { setFilters(NO_FILTERS); setPage(0); }} className="text-sm text-hud-teal underline">Clear filters</button>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!canManage} onClick={() => setDrawer(null)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-hud-gold px-3 py-2 text-sm font-semibold text-hud-bg-deep hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
          <Plus className="h-4 w-4" aria-hidden="true" />Add record
        </button>
        <button type="button" disabled={!canManage} onClick={() => setImporting(true)} className={btnCls}><Upload className="h-4 w-4" aria-hidden="true" />Import CSV</button>
        <button type="button" disabled={!filtered.length} onClick={exportCsv} className={btnCls}><Download className="h-4 w-4" aria-hidden="true" />Export CSV</button>
        <button type="button" disabled={!canManage || busy || !records.length} onClick={() => void toggleWholeRegister()} className={btnCls}>
          {allShown ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
          {allShown ? 'Hide register from client' : 'Show whole register to client'}
        </button>
        <span className="ml-auto text-xs text-hud-cream-mute">
          {filtered.length} of {records.length} row{records.length === 1 ? '' : 's'}{active && ' · filters on: export includes only the filtered rows'}
        </span>
      </div>

      {records.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hud-line-soft py-12 text-center">
          <p className="mb-3 text-sm text-hud-cream-mute">No {def.title} records yet.</p>
          {canManage && <button type="button" onClick={() => setDrawer(null)} className="inline-flex items-center gap-1.5 rounded-lg bg-hud-gold px-3 py-2 text-sm font-semibold text-hud-bg-deep"><Plus className="h-4 w-4" aria-hidden="true" />Add the first record</button>}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-hud-cream-mute">No rows match these filters.</div>
      ) : (
        <>
          <RegisterTable columns={columns} rows={visibleRows} sortKey={sortKey} sortDir={sortDir} onSort={onSort} onOpen={(r) => setDrawer(r)} />
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 text-sm text-hud-cream-dim">
              <button type="button" className={btnCls} disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous</button>
              <span>Page {safePage + 1} of {pages}</span>
              <button type="button" className={btnCls} disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>Next</button>
            </div>
          )}
        </>
      )}

      {drawer !== undefined && (
        <RecordDrawer engagement={engagement} def={def} record={drawer} canManage={canManage} onClose={() => setDrawer(undefined)} onChanged={() => void load()} />
      )}
      {importing && <CsvImportModal engagement={engagement} def={def} onClose={() => setImporting(false)} onImported={() => void load()} />}
    </div>
  );
}
export default RegistersPanel;
