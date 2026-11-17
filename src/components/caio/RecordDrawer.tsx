/** Add / edit / read one register record. Fields are generated from the register definition; the database validates every value. */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Trash2 } from 'lucide-react';
import { SlideInDrawer } from '../ui/SlideInDrawer';
import { Switch } from '../factory/ui';
import { ErrorBox, formatDate } from './ui';
import {
  createRecord, deleteRecord, recordHistory, updateRecord,
  type CaioRecord, type Engagement, type RecordHistory, type RegisterDef, type RegisterField,
} from '../../services/caio';
import { historyChanges, isLinkField, isUrl } from './registerView';

interface Props {
  engagement: Engagement;
  def: RegisterDef;
  /** null = a new record */
  record: CaioRecord | null;
  canManage: boolean;
  onClose: () => void;
  /** called after create / update / delete so the table can reload */
  onChanged: () => void;
}

const inputCls = 'w-full rounded-lg border border-hud-line-soft bg-hud-bg-card px-3 py-2 text-sm text-white placeholder:text-hud-cream-mute focus:border-hud-gold focus:outline-none disabled:opacity-60';

function ReadValue({ field, value }: { field: RegisterField; value: unknown }) {
  const s = value === null || value === undefined ? '' : String(value);
  if (!s) return <span className="text-hud-cream-mute">–</span>;
  if (isLinkField(field) && isUrl(s)) {
    return (
      <a href={s.trim()} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-hud-teal underline">
        {s}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
      </a>
    );
  }
  return <span className="whitespace-pre-wrap break-words">{field.ftype === 'date' ? formatDate(s) : s}</span>;
}

export function RecordDrawer({ engagement, def, record, canManage, onClose, onChanged }: Props) {
  const isNew = !record;
  const [values, setValues] = useState<Record<string, string>>({});
  const [clientVisible, setClientVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<RecordHistory[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // reset the form whenever a different record (or "new") is opened
  useEffect(() => {
    const v: Record<string, string> = {};
    for (const f of def.fields) v[f.field_key] = record?.data?.[f.field_key] !== undefined ? String(record.data[f.field_key]) : '';
    setValues(v);
    setClientVisible(record?.client_visible ?? false);
    setError(null);
    setShowHistory(false);
    setHistory(null);
    setHistoryError(null);
  }, [def, record]);

  useEffect(() => {
    if (!showHistory || !record || history) return;
    let live = true;
    recordHistory(record.id).then((h) => { if (live) setHistory(h); }).catch((e) => { if (live) setHistoryError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [showHistory, record, history]);

  const editable = canManage;

  const buildData = (): Record<string, unknown> => {
    const data: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.is_id) continue; // the database writes the ID field itself
      const raw = values[f.field_key] ?? '';
      if (f.ftype === 'number' && raw.trim() !== '' && !Number.isNaN(Number(raw))) data[f.field_key] = Number(raw);
      else data[f.field_key] = raw;
    }
    return data;
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (record) await updateRecord(record.id, { data: buildData(), client_visible: clientVisible });
      else await createRecord(engagement.org_id, engagement.id, def.register_key, buildData(), clientVisible);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!record) return;
    if (!window.confirm(`Delete ${record.record_key}? Its history keeps the old values.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteRecord(record.id);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const renderInput = (f: RegisterField) => {
    const id = `caio-f-${f.field_key}`;
    const value = values[f.field_key] ?? '';
    const set = (v: string) => setValues((prev) => ({ ...prev, [f.field_key]: v }));
    if (f.is_id) {
      return <div id={id} className="rounded-lg border border-hud-line-soft bg-hud-bg-elev px-3 py-2 text-sm text-hud-cream-dim">{record ? record.record_key : 'Assigned on save'}</div>;
    }
    if (!editable) return <div className="text-sm text-hud-cream-soft"><ReadValue field={f} value={value} /></div>;
    if (f.ftype === 'longtext') return <textarea id={id} rows={4} value={value} onChange={(e) => set(e.target.value)} className={inputCls} />;
    if (f.ftype === 'select') {
      const opts = f.options ?? [];
      return (
        <select id={id} value={value} onChange={(e) => set(e.target.value)} className={inputCls}>
          <option value="">(blank)</option>
          {value && !opts.includes(value) && <option value={value}>{value}</option>}
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    if (f.ftype === 'date') return <input id={id} type="date" value={value.slice(0, 10)} onChange={(e) => set(e.target.value)} className={inputCls} />;
    if (f.ftype === 'number') return <input id={id} type="number" step="any" value={value} onChange={(e) => set(e.target.value)} className={inputCls} />;
    return (
      <div className="space-y-1">
        <input id={id} type="text" value={value} onChange={(e) => set(e.target.value)} className={inputCls} />
        {isLinkField(f) && isUrl(value) && (
          <a href={value.trim()} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-hud-teal underline">Open link<ExternalLink className="h-3 w-3" aria-hidden="true" /></a>
        )}
      </div>
    );
  };

  const footer = (
    <div className="flex items-center justify-between gap-3">
      <div>
        {editable && record && (
          <button type="button" onClick={remove} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hud-plum/40 px-3 py-2 text-sm text-hud-plum hover:bg-hud-plum/10 disabled:opacity-50">
            <Trash2 className="h-4 w-4" aria-hidden="true" />Delete
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="rounded-lg border border-hud-line-soft px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-card">{editable ? 'Cancel' : 'Close'}</button>
        {editable && (
          <button type="button" onClick={save} disabled={busy}
            className="rounded-lg bg-hud-gold px-4 py-2 text-sm font-semibold text-hud-bg-deep hover:opacity-90 disabled:opacity-50">
            {busy ? 'Saving…' : isNew ? 'Add record' : 'Save changes'}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <SlideInDrawer isOpen onClose={onClose} width="lg" title={record ? record.record_key : `New ${def.title} record`}
      subtitle={def.title} footer={footer}>
      <form className="space-y-4 px-6 py-5" onSubmit={(e) => { e.preventDefault(); if (editable && !busy) void save(); }}>
        {error && <ErrorBox message={error} />}
        {def.fields.map((f) => (
          <div key={f.field_key}>
            <label htmlFor={`caio-f-${f.field_key}`} className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-hud-cream-dim">
              {f.label}
              {!f.client_safe && <span className="rounded bg-hud-bg-elev px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-hud-cream-mute" title="Never shown to the client, even when the record is visible">internal only</span>}
            </label>
            {renderInput(f)}
          </div>
        ))}

        <div className="rounded-lg border border-hud-line-soft bg-hud-bg-card p-3">
          <div className="flex items-center justify-between gap-3">
            <span id="caio-client-visible" className="text-sm font-medium text-white">Visible to client</span>
            <Switch checked={clientVisible} onChange={setClientVisible} disabled={!editable} label="Visible to client" />
          </div>
          <p className="mt-1 text-xs text-hud-cream-mute">
            The client sees this record only when the engagement&apos;s client portal is switched on. Fields marked internal only stay hidden either way.
          </p>
        </div>

        {record && (
          <div>
            <button type="button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}
              className="inline-flex items-center gap-1 text-sm font-medium text-hud-cream-soft hover:text-white">
              {showHistory ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}History
            </button>
            {showHistory && (
              <div className="mt-2 space-y-2">
                {historyError && <ErrorBox message={historyError} />}
                {!history && !historyError && <p className="text-sm text-hud-cream-mute">Loading history…</p>}
                {history && history.length === 0 && <p className="text-sm text-hud-cream-mute">No changes recorded yet.</p>}
                {history?.map((h) => {
                  const changes = historyChanges(def, h);
                  return (
                    <div key={h.id} className="rounded-lg border border-hud-line-soft p-3 text-sm">
                      <div className="mb-1 text-xs text-hud-cream-mute">{new Date(h.changed_at).toLocaleString()}{h.op === 'delete' ? ' · deleted' : ''}</div>
                      {changes.length === 0 && <div className="text-hud-cream-mute">No field changes.</div>}
                      <ul className="space-y-1">
                        {changes.map((c) => (
                          <li key={c.key} className="text-hud-cream-soft">
                            <span className="font-medium text-white">{c.label}</span>: <span className="break-words text-hud-cream-dim">{c.from}</span> → <span className="break-words">{c.to}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </form>
    </SlideInDrawer>
  );
}
export default RecordDrawer;
