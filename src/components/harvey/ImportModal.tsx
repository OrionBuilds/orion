import { useMemo, useRef, useState } from 'react';
import { Loader2, Upload, X } from 'lucide-react';
import { Badge } from '../agent-health/ui';
import type { HarveyProspect } from '../../services/harvey';
import {
  guessMapping, IMPORT_FIELDS, IMPORT_FIELD_LABEL, IMPORT_MAX, parseCsv, queueImport, rowsFromCsv, splitKnown, type ImportField,
} from '../../services/harveyGrowth';
import { reportBackgroundError } from '../../lib/errors';

const MAX_FILE_BYTES = 2_000_000;

/**
 * Import prospects from a CSV. The file is read here in the browser; what is sent is only a queued
 * command, and HARVEY still dedupes, skips anyone on his do-not-contact lists and verifies each
 * address before he emails anyone.
 */
export function ImportModal({ orgId, userId, existing, onClose, onQueued }: {
  orgId: string; userId: string; existing: HarveyProspect[]; onClose: () => void; onQueued: (message: string) => void;
}) {
  const [table, setTable] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<Array<ImportField | null>>([]);
  const [fileName, setFileName] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > MAX_FILE_BYTES) { setError('That file is over 2 MB. Split it into smaller files.'); return; }
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) { setError('The file needs a header row and at least one person.'); return; }
    setTable(parsed);
    setMapping(guessMapping(parsed[0]));
    setFileName(file.name);
    if (!label) setLabel(file.name.replace(/\.[^.]+$/, '').slice(0, 60));
  };

  const result = useMemo(() => {
    if (!table) return null;
    const { rows, rejected } = rowsFromCsv(table, mapping);
    const { fresh, known } = splitKnown(rows, existing);
    return { rows, rejected, fresh, known };
  }, [table, mapping, existing]);

  const submit = async () => {
    if (!result || result.fresh.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const n = await queueImport(orgId, userId, result.fresh.slice(0, IMPORT_MAX), label);
      onQueued(`Queued ${Math.min(result.fresh.length, IMPORT_MAX)} people for HARVEY (${n} command${n === 1 ? '' : 's'}). He imports them on his next poll, then verifies each address before anything is sent.`);
      onClose();
    } catch (err) {
      reportBackgroundError('harvey.import')(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const noContactColumn = table && !mapping.includes('email') && !mapping.includes('linkedin_url');
  const noNameColumn = table && !mapping.includes('name') && !mapping.includes('first_name') && !mapping.includes('last_name');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Import prospects">
      <div className="max-h-[90dvh] w-full max-w-3xl overflow-y-auto rounded-xl border border-hud-line-soft bg-hud-bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg text-hud-cream">Import prospects</h2>
            <p className="mt-0.5 text-xs text-hud-cream-dim">CSV with a header row. Each person needs a name and an email or LinkedIn profile link. Up to {IMPORT_MAX} at a time.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-hud-cream-dim hover:text-hud-cream"><X size={18} /></button>
        </div>

        <div className="mt-4">
          <input ref={input} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => void load(e.target.files?.[0])} />
          <button type="button" onClick={() => input.current?.click()}
            className="inline-flex items-center gap-2 rounded-md border border-hud-line-soft px-3 py-1.5 text-sm text-hud-cream hover:border-hud-gold">
            <Upload size={14} /> {fileName ? `Change file (${fileName})` : 'Choose CSV file'}
          </button>
        </div>

        {table && result && (
          <>
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-hud-cream-dim">Columns</h3>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {table[0].map((header, col) => (
                  <label key={`${header}-${col}`} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-hud-cream-soft" title={header}>{header || `(column ${col + 1})`}</span>
                    <select value={mapping[col] ?? ''} onChange={(e) => setMapping((m) => m.map((x, i) => (i === col ? ((e.target.value || null) as ImportField | null) : x)))}
                      className="rounded-md border border-hud-line-soft bg-hud-bg-elev px-2 py-1 text-xs text-hud-cream" aria-label={`Field for ${header}`}>
                      <option value="">Ignore</option>
                      {IMPORT_FIELDS.map((f) => <option key={f} value={f}>{IMPORT_FIELD_LABEL[f]}</option>)}
                    </select>
                  </label>))}
              </div>
              {noNameColumn && <p className="mt-2 text-xs text-hud-rust">No name column is mapped.</p>}
              {noContactColumn && <p className="mt-2 text-xs text-hud-rust">Map an Email or LinkedIn URL column.</p>}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="ok">{result.fresh.length} new</Badge>
              <Badge tone="muted">{result.known.length} already in the pipeline</Badge>
              <Badge tone={result.rejected.length ? 'warn' : 'muted'}>{result.rejected.length} can't be imported</Badge>
              {result.fresh.length > IMPORT_MAX && <Badge tone="warn">only the first {IMPORT_MAX} will be sent</Badge>}
            </div>
            {result.rejected.length > 0 && (
              <ul className="mt-2 max-h-28 overflow-y-auto text-xs text-hud-cream-mute">
                {result.rejected.slice(0, 20).map((r) => <li key={r.line}>Line {r.line}: {r.reason}</li>)}
                {result.rejected.length > 20 && <li>…and {result.rejected.length - 20} more</li>}
              </ul>)}

            <div className="mt-4">
              <label className="text-xs text-hud-cream-dim" htmlFor="import-label">Label (shown as the source)</label>
              <input id="import-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60}
                className="mt-1 w-full rounded-md border border-hud-line-soft bg-hud-bg-elev px-2 py-1.5 text-sm text-hud-cream" />
            </div>
            <p className="mt-3 text-xs text-hud-cream-mute">HARVEY skips anyone who opted out, is on his do-not-contact lists, or is already in his pipeline, and he checks each address before emailing anyone. Nothing is sent from this screen.</p>
          </>)}

        {error && <p className="mt-3 text-sm text-hud-plum">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-hud-line-soft px-3 py-1.5 text-sm text-hud-cream-dim hover:text-hud-cream">Cancel</button>
          <button type="button" disabled={busy || !result || result.fresh.length === 0} onClick={() => void submit()}
            className="inline-flex items-center gap-2 rounded-md bg-hud-gold px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />} Send to HARVEY{result ? ` (${Math.min(result.fresh.length, IMPORT_MAX)})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
